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
  nativeMessageId?: string;
};
export type ParsedFile = {
  events: Candidate[];
  malformed: number;
  sessionId: string;
  parentId: string;
  forkedAt: string;
  compactionIds?: Set<string>;
  retractedIds?: string[];
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

// Keep at most one bounded record in memory. Raw prompts/tool output are
// discarded as each record is visited, rather than retaining an entire log.
const recordParser = (
  parsed: ParsedFile,
  visit: (record: Metadata, line: number) => boolean,
  finalize = () => parsed,
) => {
  const maximumLength = 32 * 1024 * 1024;
  let fragments: string[] = [];
  let length = 0;
  let lineNumber = 0;
  const flush = (complete: boolean) => {
    lineNumber++;
    if (length > maximumLength) parsed.malformed++;
    else {
      const line = fragments.length === 1 ? fragments[0] : fragments.join('');
      if (line.trim()) {
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          if (complete) parsed.malformed++;
          fragments = [];
          length = 0;
          return;
        }
        if ((!isObject(record) || !visit(record, lineNumber)) && complete) parsed.malformed++;
      }
    }
    fragments = [];
    length = 0;
  };
  return {
    push(chunk: string) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf('\n', offset);
        const fragment = chunk.slice(offset, end === -1 ? undefined : end);
        length += fragment.length;
        if (length <= maximumLength) fragments.push(fragment);
        else fragments = [];
        if (end === -1) break;
        flush(true);
        offset = end + 1;
      }
    },
    finish() {
      if (length) flush(false);
      return finalize();
    },
  };
};

export const claudeParser = (file: string) => {
  const parsed: ParsedFile = { events: [], malformed: 0, sessionId: '', parentId: '', forkedAt: '' };
  return recordParser(parsed, (record, line) => {
    const message = object(record.message);
    if (record.type !== 'assistant' || !isObject(message.usage) || message.model === '<synthetic>') return true;
    const stamp = timestamp(record.timestamp);
    if (!stamp) return false;
    const session = text(record.sessionId) || fileSession(file);
    const nativeMessageId = text(message.id);
    const id = nativeMessageId
      ? `claude:message:${text(message.id)}:${text(record.requestId)}`
      : text(record.uuid)
        ? `claude:uuid:${text(record.uuid)}`
        : fallbackId('claude', session, stamp, record.ordinal, line);
    const parentTier = message.usage.speed === 'fast' ? 'priority' : text(message.usage.service_tier);
    const appendUsage = (usage: Metadata, model: unknown, usageId: string, replayId: string) => {
      const cache = object(usage.cache_creation);
      const details = object(usage.output_tokens_details);
      const event = eventBase('claude', stamp, session, model, record.cwd);
      event.id = usageId;
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
      if (!tokenTotal(event)) return;
      const tier = usage.speed === 'fast' ? 'priority' : text(usage.service_tier) || parentTier;
      parsed.events.push({
        ...candidate(
          event,
          tier,
          Math.min(event.cacheWriteTokens, number(cache.ephemeral_1h_input_tokens)),
          record.isSidechain === true,
        ),
        ...(replayId ? { nativeMessageId: replayId } : {}),
      });
    };
    appendUsage(message.usage, message.model, id, nativeMessageId);
    if (Array.isArray(message.usage.iterations)) {
      for (const [index, value] of message.usage.iterations.entries()) {
        const usage = object(value);
        if (usage.type !== 'advisor_message' || !text(usage.model) || text(usage.model) === '<synthetic>') continue;
        // Ordinary iterations repeat the main counters. Advisors are additional
        // model calls, with their own identities and parent replay ownership.
        appendUsage(
          usage,
          usage.model,
          `claude:advisor:${hash(JSON.stringify([id, index]))}`,
          nativeMessageId ? `claude:advisor:${hash(JSON.stringify([nativeMessageId, index]))}` : '',
        );
      }
    }
    return true;
  });
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
const codexTaskStart = (payload: Metadata) => {
  const started = timestamp(payload.started_at);
  const turnId = text(payload.turn_id);
  // UUIDv7 turn IDs retain their creation time even when older rollouts omit
  // started_at and rewrite every copied record's outer timestamp on a fork.
  const turnMillis = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(turnId)
    ? Number.parseInt(turnId.slice(0, 8) + turnId.slice(9, 13), 16)
    : undefined;
  if (
    turnMillis !== undefined &&
    (!started || Math.floor(turnMillis / 1000) === Math.floor(Date.parse(started) / 1000))
  )
    return { millis: turnMillis, precision: 1 };
  const precision =
    hasNumber(payload.started_at) && Number.isInteger(payload.started_at) && payload.started_at <= 1e11 ? 1000 : 1;
  return started ? { millis: Date.parse(started), precision } : undefined;
};
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

export const codexParser = (file: string) => {
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
  const snapshots: { entry: Candidate; line: number; tokens: Metadata; total: Metadata | undefined }[] = [];
  const compactionMarkers = new Map<string, number>();
  let firstMetadata = true;
  let historyStart: number | undefined;
  let copiedAncestry = false;
  let inheritedTask = false;
  let nativeStartLine: number | undefined;
  const visit = (record: Metadata, line: number) => {
    const payload = object(record.payload);
    const type = text(record.type);
    if (type === 'session_meta') {
      if (!firstMetadata) {
        if (text(payload.id) === parsed.parentId) copiedAncestry = true;
        return true;
      }
      firstMetadata = false;
      historyStart = hasNumber(payload.subagent_history_start_ordinal)
        ? payload.subagent_history_start_ordinal
        : undefined;
      parsed.sessionId = text(payload.id) || text(payload.session_id) || parsed.sessionId;
      const spawn = object(object(object(payload.source).subagent).thread_spawn);
      parsed.parentId = text(payload.forked_from_id) || text(payload.parent_thread_id) || text(spawn.parent_thread_id);
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
      if (payload.type === 'task_started' && parsed.parentId && parsed.forkedAt && nativeStartLine === undefined) {
        const start = codexTaskStart(payload);
        if (start) {
          const creation = Date.parse(parsed.forkedAt);
          if (Math.floor(start.millis / start.precision) < Math.floor(creation / start.precision)) inheritedTask = true;
          else nativeStartLine = line;
        }
        return true;
      }
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
  };
  const finalize = () => {
    // Modern thread-identified request records are authoritative. Older Codex
    // versions write request records for compaction only; treating one of those
    // as a format upgrade would discard every subsequent normal request.
    const normal = precise.filter((pending) => pending.threadId && !compactionMarkers.has(pending.responseId));
    const firstRecord = normal.reduce(
      (first, pending) => (pending.entry.event.timestamp < first ? pending.entry.event.timestamp : first),
      '\uffff',
    );
    const replayBoundary =
      parsed.parentId && (copiedAncestry || inheritedTask)
        ? (nativeStartLine ?? (inheritedTask ? Infinity : undefined))
        : undefined;
    // Outer timestamps belong to the fork write, not the copied API requests.
    // Retain their terminal total as `previous` above, but remove their usage
    // before the first native child task. Independent child requests still count.
    parsed.events = snapshots.flatMap((snapshot) => {
      if (snapshot.entry.event.timestamp >= firstRecord) return [];
      if (replayBoundary !== undefined && snapshot.line < replayBoundary) {
        (parsed.retractedIds ??= []).push(snapshot.entry.event.id);
        return [];
      }
      return [snapshot.entry];
    });
    parsed.compactionIds = new Set(
      precise.filter((pending) => compactionMarkers.has(pending.responseId)).map((pending) => pending.responseId),
    );
    for (const [index, pending] of precise.entries()) {
      const markerLine = compactionMarkers.get(pending.responseId);
      if (!pending.threadId && markerLine === undefined) continue;
      if (!pending.threadId && replayBoundary !== undefined && pending.line < replayBoundary) {
        (parsed.retractedIds ??= []).push(pending.entry.event.id);
        continue;
      }
      if (markerLine !== undefined) {
        // A local compaction's advancing snapshot can already include its
        // request. Match only the latest response between record and marker;
        // an unrelated request with equal usage must not consume this one.
        let low = 0;
        let high = snapshots.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (snapshots[middle].line <= pending.line) low = middle + 1;
          else high = middle;
        }
        const boundary = Math.min(markerLine, precise[index + 1]?.line ?? Infinity);
        let covered: (typeof snapshots)[number] | undefined;
        for (let snapshotIndex = low; snapshotIndex < snapshots.length; snapshotIndex++) {
          const snapshot = snapshots[snapshotIndex];
          if (snapshot.line >= boundary) break;
          if (
            snapshot.entry.event.timestamp < firstRecord &&
            (sameTokens(snapshot.tokens, pending.tokens) ||
              (pending.threadTokens !== undefined &&
                snapshot.total !== undefined &&
                sameTokens(pending.threadTokens, snapshot.total)))
          ) {
            covered = snapshot;
            break;
          }
        }
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
  return recordParser(parsed, visit, finalize);
};

export const piParser = (file: string) => {
  const parsed: ParsedFile = { events: [], malformed: 0, sessionId: fileSession(file), parentId: '', forkedAt: '' };
  let cwd = '';
  let model = 'unknown';
  return recordParser(parsed, (record, line) => {
    if (record.type === 'session') {
      parsed.sessionId = text(record.id) || parsed.sessionId;
      // Pi creates a new header when it copies a branch, while preserving
      // every inherited entry ID. Native filenames end in the source UUID.
      const parent = text(record.parentSession);
      parsed.parentId = parent ? fileSession(parent).split('_').at(-1) || '' : '';
      parsed.forkedAt = parent ? timestamp(record.timestamp) : '';
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
    parsed.events.push(candidate(event, '', Math.min(event.cacheWriteTokens, number(usage.cacheWrite1h))));
    return true;
  });
};

const parseContents = (contents: string, parser: ReturnType<typeof recordParser>) => {
  parser.push(contents);
  return parser.finish();
};
export const parseClaude = (contents: string, file: string) => parseContents(contents, claudeParser(file));
export const parseCodex = (contents: string, file: string) => parseContents(contents, codexParser(file));
export const parsePi = (contents: string, file: string) => parseContents(contents, piParser(file));

export const filterClaudeReplays = (files: ParsedFile[]) => {
  const originals = new Map<string, Set<string>>();
  const replayKey = (entry: Candidate) => JSON.stringify([entry.nativeMessageId, entry.event.sessionId]);
  for (const file of files)
    for (const entry of file.events) {
      if (entry.event.harness !== 'claude' || entry.sidechain || !entry.nativeMessageId) continue;
      const key = replayKey(entry);
      const identities = originals.get(key);
      if (identities) identities.add(entry.event.id);
      else originals.set(key, new Set([entry.event.id]));
    }
  for (const file of files) {
    const retracted = new Set(file.retractedIds);
    file.events = file.events.filter((entry) => {
      if (entry.event.harness !== 'claude' || !entry.sidechain || !entry.nativeMessageId) return true;
      const identities = originals.get(replayKey(entry));
      // /btw can replay a parent message with a new request ID and inflated
      // cache counts. The original request is authoritative. Keep unmatched
      // child requests and ambiguous gateway IDs rather than guessing.
      if (!identities || identities.size !== 1) return true;
      if (!identities.has(entry.event.id)) retracted.add(entry.event.id);
      return false;
    });
    if (retracted.size) file.retractedIds = [...retracted];
  }
};

export const filterPiReplays = (files: ParsedFile[]) => {
  const sessions = files.filter((file) => file.events.some(({ event }) => event.harness === 'pi'));
  const parents = new Map(sessions.map((file) => [file.sessionId, file]));
  const nativeEntries = new Map(
    sessions.map((file) => [
      file.sessionId,
      new Set(
        file.events.map(({ event }) => [event.id.slice(`pi:${file.sessionId}:`.length), event.timestamp].join(':')),
      ),
    ]),
  );
  for (const file of sessions) {
    if (!file.parentId || file.parentId === file.sessionId) continue;
    for (const entry of file.events) {
      const { event } = entry;
      const prefix = `pi:${file.sessionId}:`;
      // Derived transcripts without native entry IDs cannot prove lineage.
      if (!event.id.startsWith(prefix)) continue;
      const nativeId = event.id.slice(prefix.length);
      const oldId = event.id;
      let owner = file;
      const visited = new Set<string>([file.sessionId]);
      while (owner.parentId && !visited.has(owner.parentId)) {
        const parent = parents.get(owner.parentId);
        const inherited = nativeEntries.get(owner.parentId)?.has(`${nativeId}:${event.timestamp}`);
        const beforeCopy = owner.forkedAt && event.timestamp < owner.forkedAt;
        if (!inherited && !beforeCopy) break;
        event.sessionId = owner.parentId;
        event.id = `pi:${event.sessionId}:${nativeId}`;
        visited.add(owner.parentId);
        if (!parent) break;
        owner = parent;
      }
      if (event.id !== oldId) {
        (file.retractedIds ??= []).push(oldId);
        // The source row wins over an inherited snapshot after a downward
        // correction, even when the stale copy reports more tokens.
        entry.sidechain = true;
      }
    }
  }
};

export const filterCodexReplays = (files: ParsedFile[]) => {
  const parents = new Map(
    files.filter((file) => file.events[0]?.event.harness === 'codex').map((file) => [file.sessionId, file]),
  );
  const replayKey = (event: UsageEvent) =>
    JSON.stringify([
      event.timestamp,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.reasoningTokens,
    ]);
  const parentReplays = new Map<ParsedFile, Set<string>>();
  for (const child of files) {
    if (child.events[0]?.event.harness !== 'codex') continue;
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
      let replays = parentReplays.get(parent);
      if (!replays) {
        replays = new Set(parent.events.map((original) => replayKey(original.event)));
        parentReplays.set(parent, replays);
      }
      return !replays.has(replayKey(replay.event));
    });
    // A fork can itself become another fork's parent. If it was indexed before
    // its inherited records were filtered, later children need the new view.
    parentReplays.delete(child);
  }
};

export const deduplicate = (files: ParsedFile[]) => {
  filterClaudeReplays(files);
  filterCodexReplays(files);
  filterPiReplays(files);
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
