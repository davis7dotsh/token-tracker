import { Temporal } from '@js-temporal/polyfill';
import type { DashboardResponse, UsageEvent, UsageQuery, UsageResult } from '../../shared/domain';
import { tokenTotal } from './parsers';

const namespaces: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'xai',
  'x-ai': 'xai',
  google: 'google',
  gemini: 'google',
  google_genai: 'google',
  vertex_ai: 'google',
  'vertex-ai': 'google',
  deepseek: 'deepseek',
  qwen: 'alibaba',
  alibaba: 'alibaba',
  dashscope: 'alibaba',
  mistral: 'mistral',
  mistralai: 'mistral',
  meta: 'meta',
  'meta-llama': 'meta',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  zai: 'zai',
  'z-ai': 'zai',
  zhipu: 'zai',
  cohere: 'cohere',
  amazon: 'amazon',
  aws: 'amazon',
  bedrock: 'amazon',
  bedrock_converse: 'amazon',
  bedrock_mantle: 'amazon',
  azure: 'azure',
  azure_ai: 'azure',
  openrouter: 'openrouter',
  together: 'together',
  together_ai: 'together',
  groq: 'groq',
  perplexity: 'perplexity',
  nvidia: 'nvidia',
  huggingface: 'huggingface',
  fireworks: 'fireworks',
  fireworks_ai: 'fireworks',
};
const families = [
  ['openai', ['gpt-', 'chatgpt-', 'o1-', 'o3-', 'o4-', 'codex-mini-']],
  ['anthropic', ['claude-']],
  ['google', ['gemini-', 'gemma-']],
  ['xai', ['grok-']],
  ['deepseek', ['deepseek-']],
  ['alibaba', ['qwen']],
  ['mistral', ['mistral-', 'mixtral-', 'codestral-', 'magistral-', 'ministral-', 'devstral-']],
  ['meta', ['llama-', 'llama2-', 'llama3-', 'llama4-']],
  ['moonshot', ['kimi-', 'moonshot-']],
  ['zai', ['glm-']],
  ['cohere', ['command-r', 'command-a']],
  ['amazon', ['amazon.nova-']],
] as const;

export const provider = (model: string) => {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('/')) return namespaces[normalized.split('/')[0]] ?? 'unknown';
  for (const [name, prefixes] of families) if (prefixes.some((prefix) => normalized.startsWith(prefix))) return name;
  return ['o1', 'o3', 'o4'].includes(normalized) ? 'openai' : 'unknown';
};
export const validateTimezone = (zone: string) => {
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
};

const accumulator = () => {
  const totals = {
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUSD: 0,
    unpricedTokens: 0,
    sessions: 0,
    requests: 0,
    cacheHitRate: 0,
  };
  const sessions = new Set<string>();
  const add = (event: UsageEvent) => {
    const tokens = tokenTotal(event);
    totals.tokens += tokens;
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.cacheReadTokens += event.cacheReadTokens;
    totals.cacheWriteTokens += event.cacheWriteTokens;
    totals.reasoningTokens += event.reasoningTokens;
    totals.costUSD += event.costUsd;
    if (!event.costKnown) totals.unpricedTokens += tokens;
    totals.requests++;
    sessions.add(`${event.deviceId ?? 'local'}:${event.harness}:${event.sessionId}`);
  };
  const finish = () => ({
    ...totals,
    sessions: sessions.size,
    cacheHitRate:
      totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
        ? totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)
        : 0,
  });
  return { add, finish };
};
type Groups = Map<string, ReturnType<typeof accumulator>>;
const addGroup = (groups: Groups, name: string, event: UsageEvent) => {
  let group = groups.get(name);
  if (!group) {
    group = accumulator();
    groups.set(name, group);
  }
  group.add(event);
};
const breakdown = (groups: Groups | undefined) =>
  [...(groups ?? new Map()).entries()]
    .map(([name, group]) => ({ name, ...group.finish() }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
const selected = (names: readonly string[] | undefined, value: string) => names === undefined || names.includes(value);
const matches = (query: UsageQuery, event: UsageEvent) =>
  selected(query.harnesses, event.harness) &&
  selected(query.models, event.model) &&
  selected(query.providers, provider(event.model)) &&
  (query.projects === undefined ||
    query.projects.includes(event.repository ?? event.project) ||
    query.projects.includes(event.project)) &&
  selected(query.devices, event.deviceId ?? 'local');
const dateString = (value: Temporal.ZonedDateTime) => value.toPlainDate().toString();
const timestamp = (value: Temporal.ZonedDateTime) => value.toInstant().toString({ fractionalSecondDigits: 3 });
const inTimezone = (event: UsageEvent, zone: string) => Temporal.Instant.from(event.timestamp).toZonedDateTimeISO(zone);

export const buildDashboard = (
  data: UsageResult,
  query: UsageQuery = {},
  now = new Date(),
  machine = 'This machine',
) => {
  const requestedZone = query.timezone ?? 'UTC';
  const zone = validateTimezone(requestedZone) ? requestedZone : 'UTC';
  const range = query.range ?? '30d';
  const current = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(zone);
  const today = current.startOfDay();
  const end = today.add({ days: 1 });
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  let start = today;
  let previousStart = today.subtract({ days: 1 });
  if (range === 'all') {
    for (const event of data.events)
      if (Date.parse(event.timestamp) < start.epochMilliseconds) start = inTimezone(event, zone).startOfDay();
  } else if (range === '6m') {
    start = end.subtract({ months: 6 });
    previousStart = start.subtract({ months: 6 });
  } else if (range !== 'today') {
    start = current.subtract({ days });
    previousStart = start.subtract({ days });
  }
  const total = accumulator();
  const previous = accumulator();
  const harnessGroups: Groups = new Map();
  const modelGroups: Groups = new Map();
  const providerGroups: Groups = new Map();
  const projectGroups: Groups = new Map();
  const deviceGroups: Groups = new Map();
  const dailyGroups = new Map<string, Groups>();
  const hourlyGroups = new Map<number, Groups>();
  const sessions = new Map<
    string,
    {
      event: UsageEvent;
      startedAt: string;
      lastActiveAt: string;
      models: Set<string>;
      providers: Set<string>;
      aggregate: ReturnType<typeof accumulator>;
    }
  >();
  const availableHarnesses = new Set<string>();
  const availableModels = new Set<string>();
  const availableProviders = new Set<string>();
  const availableProjects = new Set<string>();
  const availableDevices = new Set<string>();
  for (const event of data.events) {
    const eventProvider = provider(event.model);
    const project = event.repository ?? event.project;
    const device = event.deviceId ?? 'local';
    availableHarnesses.add(event.harness);
    availableModels.add(event.model);
    availableProviders.add(eventProvider);
    availableProjects.add(project);
    availableDevices.add(device);
    const millis = Date.parse(event.timestamp);
    if (!Number.isFinite(millis) || millis > now.getTime() || !matches(query, event)) continue;
    if (range !== 'all' && millis >= previousStart.epochMilliseconds && millis < start.epochMilliseconds)
      previous.add(event);
    if (millis < start.epochMilliseconds || millis >= end.epochMilliseconds) continue;
    total.add(event);
    addGroup(harnessGroups, event.harness, event);
    addGroup(modelGroups, event.model, event);
    addGroup(providerGroups, eventProvider, event);
    addGroup(projectGroups, project, event);
    addGroup(deviceGroups, device, event);
    const date = dateString(inTimezone(event, zone));
    if (!dailyGroups.has(date)) dailyGroups.set(date, new Map());
    const dayGroup = dailyGroups.get(date);
    if (dayGroup) addGroup(dayGroup, event.harness, event);
    if (range === 'today') {
      const hour = Math.floor((millis - today.epochMilliseconds) / 3_600_000);
      if (!hourlyGroups.has(hour)) hourlyGroups.set(hour, new Map());
      const hourGroup = hourlyGroups.get(hour);
      if (hourGroup) addGroup(hourGroup, event.harness, event);
    }
    const key = `${device}:${event.harness}:${event.sessionId}`;
    let session = sessions.get(key);
    if (!session) {
      session = {
        event,
        startedAt: event.timestamp,
        lastActiveAt: event.timestamp,
        models: new Set(),
        providers: new Set(),
        aggregate: accumulator(),
      };
      sessions.set(key, session);
    }
    session.aggregate.add(event);
    session.models.add(event.model);
    session.providers.add(eventProvider);
    if (event.timestamp < session.startedAt) session.startedAt = event.timestamp;
    if (event.timestamp > session.lastActiveAt) session.lastActiveAt = event.timestamp;
  }
  const daily: DashboardResponse['daily'][number][] = [];
  for (let date = start.startOfDay(); date.epochMilliseconds < end.epochMilliseconds; date = date.add({ days: 1 })) {
    const harnesses = breakdown(dailyGroups.get(dateString(date)));
    daily.push({
      date: dateString(date),
      tokens: harnesses.reduce((sum, group) => sum + group.tokens, 0),
      costUSD: harnesses.reduce((sum, group) => sum + group.costUSD, 0),
      harnesses,
    });
  }
  const hourly: DashboardResponse['hourly'][number][] = [];
  if (range === 'today') {
    for (
      let hour = today, index = 0;
      hour.epochMilliseconds < end.epochMilliseconds;
      hour = hour.add({ hours: 1 }), index++
    ) {
      const nextHour = hour.add({ hours: 1 });
      const harnesses = breakdown(hourlyGroups.get(index));
      hourly.push({
        start: timestamp(hour),
        end: timestamp(nextHour.epochMilliseconds > end.epochMilliseconds ? end : nextHour),
        tokens: harnesses.reduce((sum, group) => sum + group.tokens, 0),
        costUSD: harnesses.reduce((sum, group) => sum + group.costUSD, 0),
        harnesses,
      });
    }
  }
  const filters = {
    harnesses: [...availableHarnesses].sort(),
    models: [...availableModels].sort(),
    providers: [...availableProviders].sort(),
    projects: [...availableProjects].sort(),
    devices: [...availableDevices].sort(),
    modelProviders: [...availableModels].sort().map((model) => ({ model, provider: provider(model) })),
  };
  return {
    machine,
    generatedAt: now.toISOString(),
    timezone: zone,
    range,
    period: { start: dateString(start), end: dateString(today) },
    totals: total.finish(),
    previous: range === 'all' ? null : previous.finish(),
    daily,
    hourly,
    harnesses: breakdown(harnessGroups),
    models: breakdown(modelGroups),
    providers: breakdown(providerGroups),
    projects: breakdown(projectGroups),
    devices: breakdown(deviceGroups),
    sessions: [...sessions.values()]
      .map((session) => ({
        id: session.event.sessionId,
        harness: session.event.harness,
        model: [...session.models].sort().join(', '),
        provider: [...session.providers].sort().join(', '),
        project: session.event.repository ?? session.event.project,
        repository: session.event.repository,
        deviceId: session.event.deviceId ?? 'local',
        startedAt: session.startedAt,
        lastActiveAt: session.lastActiveAt,
        ...session.aggregate.finish(),
      }))
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt) || left.id.localeCompare(right.id)),
    filters,
    sources: data.sources,
    warnings:
      zone === requestedZone
        ? data.warnings
        : [...data.warnings, `Timezone ${requestedZone} is unavailable; displaying UTC.`],
    pricing: {
      method:
        'Estimated API-equivalent cost using ccusage accounting and bundled LiteLLM prices. Subscription charges may differ; unknown prices are excluded.',
      updatedAt: data.pricingUpdatedAt,
    },
  } satisfies DashboardResponse;
};
