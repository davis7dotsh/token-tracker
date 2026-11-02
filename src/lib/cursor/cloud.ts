import { setTimeout as delay } from 'node:timers/promises';
import { Schema } from 'effect';
import { UsageEvent } from '../shared/domain';

export class CursorApiError extends Error {}
const invalid = () => new CursorApiError('Cursor returned inconsistent or unsupported usage data. Retry later.');
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/));
const agent = Schema.Struct({
  id,
  createdAt: UsageEvent.fields.timestamp,
  env: Schema.Struct({ type: Schema.String }),
});
const run = Schema.Struct({ id, agentId: id, createdAt: UsageEvent.fields.timestamp });
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const counts = Schema.Struct({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
});
const usage = Schema.Struct({ ...counts.fields, totalTokens: count }).check(
  Schema.makeFilter((value) => buckets.reduce((sum, key) => sum + value[key], 0) === value.totalTokens),
);
const decodeUsage = Schema.decodeUnknownSync(
  Schema.Struct({ totalUsage: usage, runs: Schema.Array(Schema.Struct({ id, usage })) }),
);
const page = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.optionalKey(Schema.NonEmptyString) });
const decodeAgents = Schema.decodeUnknownSync(page(agent));
const decodeRuns = Schema.decodeUnknownSync(page(run));

type Options = { signal?: AbortSignal; request?: (url: URL, init: RequestInit) => Promise<Response> };
const rateLimitMessage = 'Cursor rate-limited the import (HTTP 429). Retry later.';
const retryMs = (value: string | null) => {
  if (value !== null && /^\d+$/.test(value)) return Number(value) * 1000;
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 60_000;
};

const makeGet =
  (key: string, { request = fetch, signal }: Options) =>
  async (path: string, query?: URLSearchParams) => {
    // Neither continuation tokens nor upstream IDs can change the request origin.
    const url = new URL(`https://api.cursor.com/v1/${path}`);
    if (query) url.search = query.toString();
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(30_000);
      const response = await request(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) return (await response.json()) as unknown;
      await response.body?.cancel();
      if (response.status === 429) {
        const wait = retryMs(response.headers.get('retry-after'));
        if (attempt >= 2 || wait > 120_000) throw new CursorApiError(rateLimitMessage);
        await delay(wait, undefined, { signal });
        continue;
      }
      if (response.status === 401 || response.status === 403)
        throw new CursorApiError(
          `Cursor denied Cloud Agents access (HTTP ${response.status}). Check your personal API key and account access.`,
        );
      throw new CursorApiError(`Cursor could not return cloud agent usage (HTTP ${response.status}).`);
    }
  };

type Get = ReturnType<typeof makeGet>;
async function* items<A>(
  get: Get,
  path: string,
  decode: (body: unknown) => { items: readonly A[]; nextCursor?: string },
  includeArchived = false,
) {
  const query = new URLSearchParams({ limit: '100' });
  if (includeArchived) query.set('includeArchived', 'true');
  const cursors = new Set<string>();
  for (;;) {
    const body = decode(await get(path, query));
    yield* body.items;
    if (body.nextCursor === undefined) return;
    if (cursors.has(body.nextCursor)) throw invalid();
    cursors.add(body.nextCursor);
    query.set('cursor', body.nextCursor);
  }
}

const makeEvent = (agentId: string, suffix: string, stamp: string, tokens: typeof counts.Type): UsageEvent => ({
  id: `cursor:${agentId}:${suffix}`,
  sessionId: agentId,
  timestamp: new Date(stamp).toISOString(),
  harness: 'cursor',
  model: 'cursor/unknown',
  project: 'Cursor Cloud',
  repository: null,
  inputTokens: tokens.inputTokens,
  outputTokens: tokens.outputTokens,
  cacheReadTokens: tokens.cacheReadTokens,
  cacheWriteTokens: tokens.cacheWriteTokens,
  // Cursor exposes token counts, not model calls, reasoning splits, or costs.
  requests: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costKnown: false,
});

const agentEvents = async (get: Get, current: typeof agent.Type) => {
  const path = `agents/${current.id}`;
  const usage = decodeUsage(await get(`${path}/usage`));
  const stamps = new Map<string, string>();
  if (usage.runs.some((r) => r.usage.totalTokens > 0)) {
    // List after taking the usage snapshot: concurrently created runs without
    // usage won't affect the accounting; no per-run chat/result calls needed.
    for await (const entry of items(get, `${path}/runs`, decodeRuns)) {
      if (entry.agentId !== current.id) throw invalid();
      stamps.set(entry.id, entry.createdAt);
    }
  }
  const seen = new Set<string>();
  const events: UsageEvent[] = [];
  const remaining = { ...usage.totalUsage };
  for (const row of usage.runs) {
    if (seen.has(row.id)) throw invalid();
    seen.add(row.id);
    if (!row.usage.totalTokens) continue;
    const stamp = stamps.get(row.id);
    if (!stamp) throw invalid();
    for (const bucket of buckets) {
      remaining[bucket] -= row.usage[bucket];
      if (remaining[bucket] < 0) throw invalid();
    }
    events.push(makeEvent(current.id, `run:${row.id}`, stamp, row.usage));
  }
  // The unscoped total also includes subagents, side chats and other work not
  // tied to a run. Record only the difference once, dated to the agent start.
  if (buckets.some((bucket) => remaining[bucket] > 0))
    events.push(makeEvent(current.id, 'unattributed', current.createdAt, remaining));
  return events;
};

export const fetchCursorUsage = async (apiKey: string, options: Options = {}) => {
  const get = makeGet(apiKey, options);
  const agentIds = new Set<string>();
  const events: UsageEvent[] = [];
  try {
    for await (const current of items(get, 'agents', decodeAgents, true)) {
      if (current.env.type !== 'cloud' || agentIds.has(current.id)) continue;
      agentIds.add(current.id);
      for (const event of await agentEvents(get, current)) events.push(event);
    }
  } catch (error) {
    // HTTP bodies, schema diagnostics and transport errors can contain agent
    // titles, run results or credentials. Never pass them to CLI diagnostics.
    if (error instanceof CursorApiError) throw error;
    if (options.signal?.aborted) throw new CursorApiError('Cursor import cancelled.');
    if (Schema.isSchemaError(error) || error instanceof SyntaxError) throw invalid();
    throw new CursorApiError('Could not reach Cursor or finish reading its response. Retry later.');
  }
  return { events, agentIds: [...agentIds] };
};
