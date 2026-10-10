import { Temporal } from '@js-temporal/polyfill';
import type { DashboardResponse, SessionMetadata, UsageEvent, UsageQuery, UsageResult } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { provider } from '../../shared/provider';
import { tokenTotal } from './parsers';
import { bundledPolicy, tokenCostParts } from './pricing';
export { provider } from '../../shared/provider';
const sessionMetadataKeys = ['sessionTitle', 'projectName'] as const;
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
  const add = (
    event: UsageEvent,
    key = `${event.deviceId ?? 'local'}:${event.harness}:${event.sessionId}`,
    tokens = tokenTotal(event),
  ) => {
    totals.tokens += tokens;
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.cacheReadTokens += event.cacheReadTokens;
    totals.cacheWriteTokens += event.cacheWriteTokens;
    totals.reasoningTokens += event.reasoningTokens;
    totals.costUSD += event.costUsd;
    if (!event.costKnown) totals.unpricedTokens += tokens;
    totals.requests += event.requests ?? 1;
    sessions.add(key);
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
const addGroup = (groups: Groups, name: string, event: UsageEvent, session: string, tokens: number) => {
  let group = groups.get(name);
  if (!group) {
    group = accumulator();
    groups.set(name, group);
  }
  group.add(event, session, tokens);
};
const breakdown = (groups: Groups | undefined) =>
  [...(groups ?? new Map()).entries()]
    .map(([name, group]) => ({ name, ...group.finish() }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
const seriesTotals = () => ({ tokens: 0, costUSD: 0, unpricedTokens: 0 });
type SeriesGroups = Map<string, ReturnType<typeof seriesTotals>>;
const addSeries = (groups: SeriesGroups, name: string, event: UsageEvent, tokens: number) => {
  let group = groups.get(name);
  if (!group) {
    group = seriesTotals();
    groups.set(name, group);
  }
  group.tokens += tokens;
  group.costUSD += event.costUsd;
  if (!event.costKnown) group.unpricedTokens += tokens;
};
const series = (groups: SeriesGroups | undefined) =>
  [...(groups ?? new Map()).entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
const bucketGroups = () => ({
  harnesses: new Map<string, ReturnType<typeof accumulator>>(),
  providers: new Map<string, ReturnType<typeof seriesTotals>>(),
  models: new Map<string, ReturnType<typeof seriesTotals>>(),
});
const addBucket = <Key>(
  groups: Map<Key, ReturnType<typeof bucketGroups>>,
  bucket: Key,
  event: UsageEvent,
  eventProvider: string,
  session: string,
  tokens: number,
) => {
  let group = groups.get(bucket);
  if (!group) {
    group = bucketGroups();
    groups.set(bucket, group);
  }
  addGroup(group.harnesses, event.harness, event, session, tokens);
  addSeries(group.providers, eventProvider, event, tokens);
  addSeries(group.models, event.model, event, tokens);
};
const selected = (names: readonly string[] | undefined, value: string) => names === undefined || names.includes(value);
export const matchesUsage = (query: UsageQuery, event: UsageEvent, eventProvider = provider(event.model)) =>
  selected(query.harnesses, event.harness) &&
  selected(query.models, event.model) &&
  selected(query.providers, eventProvider) &&
  (query.projects === undefined ||
    query.projects.includes(event.repository ?? event.project) ||
    query.projects.includes(event.project)) &&
  selected(query.devices, event.deviceId ?? 'local');
const dateString = (value: Temporal.ZonedDateTime) => value.toPlainDate().toString();
const timestamp = (value: Temporal.ZonedDateTime) => value.toInstant().toString({ fractionalSecondDigits: 3 });
const eventTimestamps = new WeakMap<UsageEvent, number>();
export const eventMillis = (event: UsageEvent) => {
  const cached = eventTimestamps.get(event);
  if (cached !== undefined) return cached;
  const millis = Date.parse(event.timestamp);
  eventTimestamps.set(event, millis);
  return millis;
};
export const usageTimeframe = (query: UsageQuery = {}, now = new Date()) => {
  const requestedZone = query.timezone ?? 'UTC';
  const zone = validateTimezone(requestedZone) ? requestedZone : 'UTC';
  const range = query.range ?? '30d';
  const current = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(zone);
  const today = current.startOfDay();
  const end = today.add({ days: 1 }).startOfDay();
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  let start = today;
  let previousStart = today.subtract({ days: 1 });
  if (range === '6m') {
    start = end.subtract({ months: 6 });
    previousStart = start.subtract({ months: 6 });
  } else if (range !== 'today' && range !== 'all') {
    start = current.subtract({ days });
    previousStart = start.subtract({ days });
  }
  return { requestedZone, zone, range, today, end, start, previousStart };
};

export const buildDashboard = (
  data: UsageResult,
  query: UsageQuery = {},
  now = new Date(),
  machine = 'This machine',
  pricingPolicy: PricingPolicy = bundledPolicy,
) => {
  const timeframe = usageTimeframe(query, now);
  const { requestedZone, zone, range, today, end, previousStart } = timeframe;
  let { start } = timeframe;
  if (range === 'all') {
    let earliest = start.epochMilliseconds;
    for (const event of data.events) {
      const millis = eventMillis(event);
      if (millis < earliest) earliest = millis;
    }
    start = Temporal.Instant.fromEpochMilliseconds(earliest).toZonedDateTimeISO(zone).startOfDay();
  }
  // Convert calendar boundaries once, rather than running the Temporal polyfill
  // for every request record. Binary search preserves DST and non-hour offsets.
  const calendarDays: { date: string; start: number; end: number }[] = [];
  for (
    let date = start.startOfDay();
    date.epochMilliseconds < end.epochMilliseconds;
    date = date.add({ days: 1 }).startOfDay()
  ) {
    calendarDays.push({
      date: dateString(date),
      start: date.epochMilliseconds,
      end: date.add({ days: 1 }).startOfDay().epochMilliseconds,
    });
  }
  const dayFor = (millis: number) => {
    let low = 0;
    let high = calendarDays.length - 1;
    while (low <= high) {
      const index = (low + high) >>> 1;
      const day = calendarDays[index];
      if (millis < day.start) high = index - 1;
      else if (millis >= day.end) low = index + 1;
      else return day.date;
    }
    return '';
  };
  const nowMillis = now.getTime();
  const startMillis = start.epochMilliseconds;
  const previousMillis = previousStart.epochMilliseconds;
  const endMillis = end.epochMilliseconds;
  const todayMillis = today.epochMilliseconds;
  const total = accumulator();
  const tokenCosts = {
    input: { costUSD: 0, unavailableTokens: 0 },
    output: { costUSD: 0, unavailableTokens: 0 },
    cacheRead: { costUSD: 0, unavailableTokens: 0 },
    cacheWrite: { costUSD: 0, unavailableTokens: 0 },
    unattributedCostUSD: 0,
  };
  const previous = accumulator();
  const harnessGroups: Groups = new Map();
  const modelGroups: Groups = new Map();
  const providerGroups: Groups = new Map();
  const projectGroups: Groups = new Map();
  const deviceGroups: Groups = new Map();
  const dailyGroups = new Map<string, ReturnType<typeof bucketGroups>>();
  const hourlyGroups = new Map<number, ReturnType<typeof bucketGroups>>();
  const sessions = new Map<
    string,
    {
      event: UsageEvent;
      startedAt: string;
      lastActiveAt: string;
      models: Set<string>;
      providers: Set<string>;
      metadata: { -readonly [Key in keyof SessionMetadata]: SessionMetadata[Key] };
      metadataUpdatedAt: Map<keyof SessionMetadata, number>;
      aggregate: ReturnType<typeof accumulator>;
    }
  >();
  const availableHarnesses = new Set<string>();
  const availableModels = new Set<string>();
  const availableProviders = new Set<string>();
  const availableProjects = new Set<string>();
  const availableDevices = new Set<string>();
  const modelProviders = new Map<string, string>();
  for (const event of data.events) {
    let eventProvider = modelProviders.get(event.model);
    if (eventProvider === undefined) {
      eventProvider = provider(event.model);
      modelProviders.set(event.model, eventProvider);
    }
    const project = event.repository ?? event.project;
    const device = event.deviceId ?? 'local';
    availableHarnesses.add(event.harness);
    availableModels.add(event.model);
    availableProviders.add(eventProvider);
    availableProjects.add(project);
    availableDevices.add(device);
    const millis = eventMillis(event);
    if (!Number.isFinite(millis) || millis > nowMillis || !matchesUsage(query, event, eventProvider)) continue;
    const key = `${device}:${event.harness}:${event.sessionId}`;
    const tokens = tokenTotal(event);
    if (range !== 'all' && millis >= previousMillis && millis < startMillis) previous.add(event);
    if (millis < startMillis || millis >= endMillis) continue;
    total.add(event, key, tokens);
    const costParts = tokenCostParts(event, pricingPolicy);
    if (costParts) {
      tokenCosts.input.costUSD += costParts.input;
      tokenCosts.output.costUSD += costParts.output;
      tokenCosts.cacheRead.costUSD += costParts.cacheRead;
      tokenCosts.cacheWrite.costUSD += costParts.cacheWrite;
    } else {
      tokenCosts.input.unavailableTokens += event.inputTokens;
      tokenCosts.output.unavailableTokens += event.outputTokens;
      tokenCosts.cacheRead.unavailableTokens += event.cacheReadTokens;
      tokenCosts.cacheWrite.unavailableTokens += event.cacheWriteTokens;
      if (event.costKnown) tokenCosts.unattributedCostUSD += event.costUsd;
    }
    addGroup(harnessGroups, event.harness, event, key, tokens);
    addGroup(modelGroups, event.model, event, key, tokens);
    addGroup(providerGroups, eventProvider, event, key, tokens);
    addGroup(projectGroups, project, event, key, tokens);
    addGroup(deviceGroups, device, event, key, tokens);
    const date = dayFor(millis);
    addBucket(dailyGroups, date, event, eventProvider, key, tokens);
    if (range === 'today') {
      const hour = Math.floor((millis - todayMillis) / 3_600_000);
      addBucket(hourlyGroups, hour, event, eventProvider, key, tokens);
    }
    let session = sessions.get(key);
    if (!session) {
      session = {
        event,
        startedAt: event.timestamp,
        lastActiveAt: event.timestamp,
        models: new Set(),
        providers: new Set(),
        metadata: {},
        metadataUpdatedAt: new Map(),
        aggregate: accumulator(),
      };
      sessions.set(key, session);
    }
    session.aggregate.add(event, key, tokens);
    session.models.add(event.model);
    session.providers.add(eventProvider);
    // Older collectors can upload records without optional metadata. Keep each
    // field's newest available value regardless of the accounting event order.
    for (const field of sessionMetadataKeys) {
      const value = event[field]?.trim();
      const updatedAt = session.metadataUpdatedAt.get(field);
      if (value && (updatedAt === undefined || millis >= updatedAt)) {
        session.metadata[field] = value;
        session.metadataUpdatedAt.set(field, millis);
      }
    }
    // A thread ID and its URL describe one destination. Keep them together so
    // partial metadata cannot accidentally link a newer ID to an older thread.
    const threadId = event.t3ThreadId?.trim();
    const threadUrl = event.t3ThreadUrl?.trim();
    const threadUpdatedAt = session.metadataUpdatedAt.get('t3ThreadId');
    if ((threadId || threadUrl) && (threadUpdatedAt === undefined || millis >= threadUpdatedAt)) {
      delete session.metadata.t3ThreadId;
      delete session.metadata.t3ThreadUrl;
      if (threadId) session.metadata.t3ThreadId = threadId;
      if (threadUrl) session.metadata.t3ThreadUrl = threadUrl;
      session.metadataUpdatedAt.set('t3ThreadId', millis);
    }
    if (event.timestamp < session.startedAt) session.startedAt = event.timestamp;
    if (event.timestamp > session.lastActiveAt) session.lastActiveAt = event.timestamp;
  }
  const daily: DashboardResponse['daily'][number][] = [];
  for (const date of calendarDays) {
    const groups = dailyGroups.get(date.date);
    const harnesses = breakdown(groups?.harnesses);
    daily.push({
      date: date.date,
      tokens: harnesses.reduce((sum, group) => sum + group.tokens, 0),
      costUSD: harnesses.reduce((sum, group) => sum + group.costUSD, 0),
      harnesses,
      providers: series(groups?.providers),
      models: series(groups?.models),
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
      const groups = hourlyGroups.get(index);
      const harnesses = breakdown(groups?.harnesses);
      hourly.push({
        start: timestamp(hour),
        end: timestamp(nextHour.epochMilliseconds > end.epochMilliseconds ? end : nextHour),
        tokens: harnesses.reduce((sum, group) => sum + group.tokens, 0),
        costUSD: harnesses.reduce((sum, group) => sum + group.costUSD, 0),
        harnesses,
        providers: series(groups?.providers),
        models: series(groups?.models),
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
    tokenCosts,
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
        ...session.metadata,
        id: session.event.sessionId,
        harness: session.event.harness,
        model: [...session.models].sort().join(', '),
        provider: [...session.providers].sort().join(', '),
        project: session.event.project,
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
        'API-equivalent cost from complete native Grok accounting, cached model prices, and saved pricing rules. Subscription charges may differ; unavailable costs are excluded.',
      updatedAt: data.pricingUpdatedAt,
    },
  } satisfies DashboardResponse;
};
