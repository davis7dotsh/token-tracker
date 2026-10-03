import { createHash } from 'node:crypto';
import type { Harness, UsageEvent } from '../../shared/domain';

type Metadata = Record<string, unknown>;
type MutableEvent = { -readonly [K in keyof UsageEvent]: UsageEvent[K] };
type Candidate = {
  event: MutableEvent;
  source: number;
  sidechain: boolean;
  cacheWrite1h: number;
  tier: string;
};
export type ParsedFile = {
  events: Candidate[];
  malformed: number;
  sessionId: string;
  parentId: string;
  forkedAt: string;
  compactionIds?: Set<string>;
};

const isObject = (value: unknown): value is Metadata =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const object = (value: unknown) => (isObject(value) ? value : {});
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const modelName = (value: unknown) => (text(value) && text(value) !== '<synthetic>' ? text(value) : 'unknown');
const projectName = (value: unknown) => text(value) || 'Unknown project';
const fileSession = (file: string) =>
  file
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.jsonl$/i, '') || 'unknown';
export const tokenTotal = (event: UsageEvent) =>
  event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fallbackId = (harness: string, session: string, timestamp: string, ordinal: unknown, line: number) =>
  `${harness}:metadata:${hash(JSON.stringify([session, timestamp, hasNumber(ordinal) ? ordinal : line]))}`;

const timestamp = (value: unknown) => {
  const millis =
    typeof value === 'number'
      ? value > 1e11
        ? value
        : value * 1000
      : typeof value === 'string'
        ? Date.parse(value.trim())
        : NaN;
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : '';
};
const eventBase = (
  harness: typeof Harness.Type,
  stamp: string,
  sessionId: string,
  model: unknown,
  project: unknown,
): MutableEvent => ({
  id: '',
  timestamp: stamp,
  harness,
  sessionId,
  model: modelName(model),
  project: projectName(project),
  repository: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costKnown: false,
});
const candidate = (event: MutableEvent, tier = '', cacheWrite1h = 0, sidechain = false): Candidate => ({
  event,
  tier,
  cacheWrite1h,
  sidechain,
  source: 0,
});

// JSON is treated as unknown. Only the metadata fields we recognize are copied
// into events; an unfinished final append is expected in a live harness log.
const readRecords = (contents: string, visit: (record: Metadata, line: number) => boolean) => {
  const lines = contents.split('\n');
  let malformed = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (line.length > 32 * 1024 * 1024) {
      malformed++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index < lines.length - 1) malformed++;
      continue;
    }
    if (!isObject(parsed) || !visit(parsed, index + 1)) {
      if (index < lines.length - 1) malformed++;
    }
  }
  return malformed;
};

export const parseClaude = (contents: string, file: string): ParsedFile => {
  const parsed: ParsedFile = { events: [], malformed: 0, sessionId: '', parentId: '', forkedAt: '' };
  parsed.malformed = readRecords(contents, (record, line) => {
    const message = object(record.message);
    if (record.type !== 'assistant' || !isObject(message.usage) || message.model === '<synthetic>') return true;
    const stamp = timestamp(record.timestamp);
    if (!stamp) return false;
    const usage = message.usage;
    const cache = object(usage.cache_creation);
    const details = object(usage.output_tokens_details);
    const session = text(record.sessionId) || fileSession(file);
    const event = eventBase('claude', stamp, session, message.model, record.cwd);
    event.inputTokens = number(usage.input_tokens);
    event.outputTokens = number(usage.output_tokens);
    event.cacheReadTokens = number(usage.cache_read_input_tokens);
    event.cacheWriteTokens = Math.max(
      number(usage.cache_creation_input_tokens),
      number(cache.ephemeral_1h_input_tokens) + number(cache.ephemeral_5m_input_tokens),
    );
    event.reasoningTokens = Math.min(
      event.outputTokens,
      Math.max(number(details.thinking_tokens), number(details.reasoning_tokens)),
    );
    if (!tokenTotal(event)) return true;
    event.id = text(message.id)
      ? `claude:message:${text(message.id)}:${text(record.requestId)}`
      : text(record.uuid)
        ? `claude:uuid:${text(record.uuid)}`
        : fallbackId('claude', session, stamp, record.ordinal, line);
    const tier = usage.speed === 'fast' ? 'priority' : text(usage.service_tier);
    parsed.events.push(
      candidate(
        event,
        tier,
        Math.min(event.cacheWriteTokens, number(cache.ephemeral_1h_input_tokens)),
        record.isSidechain === true,
      ),
    );
    return true;
  });
  return parsed;
};

const codexModel = (record: Metadata) =>
  text(record.model) || text(record.model_name) || text(object(record.metadata).model);
const tokenFields = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;
const codexTokens = (record: Metadata) =>
  Object.fromEntries(tokenFields.map((field) => [field, number(record[field])]));
const sameTokens = (left: Metadata, right: Metadata) =>
  tokenFields.every((field) => number(left[field]) === number(right[field]));
const tokenDelta = (current: Metadata, previous: Metadata | undefined) => {
  if (
    !previous ||
    number(current.input_tokens) < number(previous.input_tokens) ||
    number(current.output_tokens) < number(previous.output_tokens) ||
    (number(current.total_tokens) > 0 &&
      number(previous.total_tokens) > 0 &&
      number(current.total_tokens) < number(previous.total_tokens))
  )
    return codexTokens(current);
  return Object.fromEntries(
    tokenFields.map((field) => [field, Math.max(0, number(current[field]) - number(previous[field]))]),
  );
};
type CodexContext = { model: string; cwd: string; tier: string };
const codexEvent = (stamp: string, session: string, context: CodexContext, tokens: Metadata) => {
  const event = eventBase('codex', stamp, session, context.model, context.cwd);
  const input = number(tokens.input_tokens);
  event.cacheReadTokens = Math.min(number(tokens.cached_input_tokens), input);
  event.cacheWriteTokens = Math.min(
    Math.max(number(tokens.cache_write_input_tokens), number(tokens.cache_creation_input_tokens)),
    input - event.cacheReadTokens,
  );
  event.inputTokens = input - event.cacheReadTokens - event.cacheWriteTokens;
  event.outputTokens = number(tokens.output_tokens);
  event.reasoningTokens = Math.min(number(tokens.reasoning_output_tokens), event.outputTokens);
  return event;
};

export const parseCodex = (contents: string, file: string): ParsedFile => {
  const parsed: ParsedFile = { events: [], malformed: 0, sessionId: fileSession(file), parentId: '', forkedAt: '' };
  let context: CodexContext = { model: 'unknown', cwd: '', tier: '' };
  const contexts = new Map<string, CodexContext>();
  let previous: Metadata | undefined;
  const precise: {
    entry: Candidate;
    turnId: string;
    explicitModel: string;
    threadId: string;
    responseId: string;
    line: number;
    tokens: Metadata;
    threadTokens: Metadata | undefined;
  }[] = [];
  const cumulative: Candidate[] = [];
  const snapshots: { entry: Candidate; line: number; tokens: Metadata; total: Metadata | undefined }[] = [];
  const compactionMarkers = new Map<string, number>();
  let firstMetadata = true;
  let historyStart: number | undefined;
  parsed.malformed = readRecords(contents, (record, line) => {
    const payload = object(record.payload);
    const type = text(record.type);
    if (type === 'session_meta') {
      if (!firstMetadata) return true;
      firstMetadata = false;
      historyStart = hasNumber(payload.subagent_history_start_ordinal)
        ? payload.subagent_history_start_ordinal
        : undefined;
      parsed.sessionId = text(payload.id) || text(payload.session_id) || parsed.sessionId;
      parsed.parentId = text(payload.forked_from_id) || text(payload.parent_thread_id);
      parsed.forkedAt = timestamp(payload.timestamp) || timestamp(record.timestamp);
      context = {
        ...context,
        cwd: text(payload.cwd),
        model: codexModel(payload) ? modelName(codexModel(payload)) : context.model,
      };
      return true;
    }
    if (type === 'turn_context') {
      context = {
        model: codexModel(payload) ? modelName(codexModel(payload)) : context.model,
        cwd: text(payload.cwd) || context.cwd,
        tier: typeof payload.service_tier === 'string' ? text(payload.service_tier) : context.tier,
      };
      if (text(payload.turn_id)) contexts.set(text(payload.turn_id), { ...context });
      return true;
    }
    if (type === 'compacted') {
      const responseId = text(payload.compaction_response_id);
      if (responseId && !compactionMarkers.has(responseId)) compactionMarkers.set(responseId, line);
      return true;
    }
    if (type === 'event_msg') {
      if (payload.type === 'thread_settings_applied') {
        const tier = object(payload.thread_settings).service_tier;
        if (typeof tier === 'string') context = { ...context, tier: text(tier) };
        return true;
      }
      if (payload.type !== 'token_count' || !isObject(payload.info)) return true;
      const stamp = timestamp(record.timestamp);
      if (!stamp) return false;
      const info = payload.info;
      let tokens: Metadata | undefined;
      if (isObject(info.total_token_usage)) {
        const totals = info.total_token_usage;
        if (!previous || !sameTokens(totals, previous)) {
          tokens = isObject(info.last_token_usage) ? info.last_token_usage : tokenDelta(totals, previous);
        }
        previous = codexTokens(totals);
      } else if (isObject(info.last_token_usage)) tokens = info.last_token_usage;
      if (!tokens || (historyStart !== undefined && hasNumber(record.ordinal) && record.ordinal < historyStart))
        return true;
      const current = { ...context, model: codexModel(payload) || codexModel(info) || context.model };
      const event = codexEvent(stamp, parsed.sessionId, current, tokens);
      if (tokenTotal(event)) {
        event.id = `codex:total:${hash(JSON.stringify([parsed.sessionId, stamp, event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens, event.reasoningTokens]))}`;
        const entry = candidate(event, current.tier);
        cumulative.push(entry);
        snapshots.push({
          entry,
          line,
          tokens,
          total: isObject(info.total_token_usage) ? info.total_token_usage : undefined,
        });
      }
      return true;
    }
    if (type !== 'token_usage_record' || !isObject(payload.usage)) return true;
    if (historyStart !== undefined && hasNumber(record.ordinal) && record.ordinal < historyStart) return true;
    const stamp = timestamp(record.timestamp);
    if (!stamp) return false;
    if (text(payload.thread_id) && text(payload.thread_id) !== parsed.sessionId) return true;
    const event = codexEvent(stamp, parsed.sessionId, context, payload.usage);
    if (!tokenTotal(event)) return true;
    event.id = text(payload.response_id)
      ? `codex:response:${text(payload.response_id)}`
      : fallbackId('codex', parsed.sessionId, stamp, record.ordinal, line);
    precise.push({
      entry: candidate(event, text(payload.service_tier) || context.tier),
      turnId: text(payload.turn_id),
      explicitModel: codexModel(payload),
      threadId: text(payload.thread_id),
      responseId: text(payload.response_id),
      line,
      tokens: payload.usage,
      threadTokens: isObject(payload.thread_token_usage) ? payload.thread_token_usage : undefined,
    });
    return true;
  });
  // Modern thread-identified request records are authoritative. Older Codex
  // versions write request records for compaction only; treating one of those
  // as a format upgrade would discard every subsequent normal request.
  const normal = precise.filter((pending) => pending.threadId && !compactionMarkers.has(pending.responseId));
  const firstRecord = normal.reduce(
    (first, pending) => (pending.entry.event.timestamp < first ? pending.entry.event.timestamp : first),
    '\uffff',
  );
  parsed.events = cumulative.filter((entry) => entry.event.timestamp < firstRecord);
  parsed.compactionIds = new Set(
    precise.filter((pending) => compactionMarkers.has(pending.responseId)).map((pending) => pending.responseId),
  );
  for (const pending of precise) {
    const markerLine = compactionMarkers.get(pending.responseId);
    if (!pending.threadId && markerLine === undefined) continue;
    if (markerLine !== undefined) {
      // A local compaction's advancing snapshot can already include its
      // request. Match only the latest response between record and marker;
      // an unrelated request with equal usage must not consume this one.
      const covered = snapshots.find(
        (snapshot) =>
          snapshot.line > pending.line &&
          snapshot.line < markerLine &&
          snapshot.entry.event.timestamp < firstRecord &&
          !precise.some((later) => later.line > pending.line && later.line < snapshot.line) &&
          (sameTokens(snapshot.tokens, pending.tokens) ||
            (pending.threadTokens !== undefined &&
              snapshot.total !== undefined &&
              sameTokens(pending.threadTokens, snapshot.total))),
      );
      if (covered) {
        // Retain the native identity even when the accounting came from the
        // cumulative snapshot, so copied records can deduplicate on a server.
        covered.entry.event.id = pending.entry.event.id;
        continue;
      }
    }
    const turn = contexts.get(pending.turnId);
    if (turn) {
      pending.entry.event.model = turn.model;
      pending.entry.event.project = projectName(turn.cwd);
      pending.entry.tier ||= turn.tier;
    }
    if (pending.explicitModel) pending.entry.event.model = modelName(pending.explicitModel);
    parsed.events.push(pending.entry);
  }
  return parsed;
};

export const parsePi = (contents: string, file: string): ParsedFile => {
  const parsed: ParsedFile = { events: [], malformed: 0, sessionId: fileSession(file), parentId: '', forkedAt: '' };
  let cwd = '';
  let model = 'unknown';
  parsed.malformed = readRecords(contents, (record, line) => {
    if (record.type === 'session') {
      parsed.sessionId = text(record.id) || parsed.sessionId;
      cwd = text(record.cwd);
      return true;
    }
    if (record.type === 'model_change') {
      model = modelName(record.modelId);
      return true;
    }
    const message = object(record.message);
    if (record.type !== 'message' || message.role !== 'assistant' || !isObject(message.usage)) return true;
    const stamp = timestamp(record.timestamp);
    if (!stamp) return false;
    if (text(message.model)) model = modelName(message.model);
    const usage = message.usage;
    const event = eventBase('pi', stamp, parsed.sessionId, model, cwd);
    event.inputTokens = number(usage.input);
    event.outputTokens = number(usage.output);
    event.cacheReadTokens = number(usage.cacheRead);
    event.cacheWriteTokens = number(usage.cacheWrite);
    event.reasoningTokens = Math.min(number(usage.reasoning), event.outputTokens);
    if (!tokenTotal(event)) return true;
    event.id = text(record.id)
      ? `pi:${parsed.sessionId}:${text(record.id)}`
      : fallbackId('pi', parsed.sessionId, stamp, record.ordinal, line);
    parsed.events.push(candidate(event));
    return true;
  });
  return parsed;
};

export const filterCodexReplays = (files: ParsedFile[]) => {
  const parents = new Map(
    files.filter((file) => file.events[0]?.event.harness === 'codex').map((file) => [file.sessionId, file]),
  );
  for (const child of files) {
    if (!child.parentId || child.parentId === child.sessionId) continue;
    const parent = parents.get(child.parentId);
    child.events = child.events.filter((replay) => {
      if (child.forkedAt && replay.event.timestamp < child.forkedAt) return false;
      if (
        parent &&
        child.compactionIds?.has(replay.event.id.replace(/^codex:response:/, '')) &&
        parent.compactionIds?.has(replay.event.id.replace(/^codex:response:/, ''))
      )
        return false;
      if (!parent || parent === child || !replay.event.id.startsWith('codex:total:')) return true;
      return !parent.events.some(
        (original) =>
          original.event.timestamp === replay.event.timestamp &&
          ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].every(
            (field) =>
              Object.entries(original.event).find(([key]) => key === field)?.[1] ===
              Object.entries(replay.event).find(([key]) => key === field)?.[1],
          ),
      );
    });
  }
};

export const deduplicate = (files: ParsedFile[]) => {
  filterCodexReplays(files);
  const entries = new Map<string, Candidate>();
  for (const file of files)
    for (const incoming of file.events) {
      const existing = entries.get(incoming.event.id);
      if (
        !existing ||
        (existing.sidechain && !incoming.sidechain) ||
        (existing.sidechain === incoming.sidechain && tokenTotal(incoming.event) > tokenTotal(existing.event))
      )
        entries.set(incoming.event.id, incoming);
    }
  return [...entries.values()];
};
