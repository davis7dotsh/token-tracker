import { Schema } from 'effect';
import { Harness, type UsageEvent } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { tokenTotal } from '../usage/parsers';
import { estimateCost, resolveDisplayModel } from '../usage/pricing';

// One row of traces.v_usage_events (013_usage_events.sql), selected by the
// trace source with millisecond timestamps and numeric 64-bit counters. The
// view owns the provider-specific token mapping; rows arrive in tracker classes.
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const TraceRow = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  requested_at: Schema.String,
  session_key: Schema.String,
  harness: Schema.String,
  machine: Schema.String,
  machine_os: Schema.String,
  cwd: Schema.String,
  repository: Schema.String,
  title: Schema.String,
  is_subagent: Schema.Boolean,
  session_updated_at: Schema.String,
  model: Schema.String,
  service_tier: Schema.String,
  failed: Schema.Boolean,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  cache_write_tokens: Count,
  cache_write_1h_tokens: Count,
  reasoning_tokens: Count,
});
export type TraceRow = typeof TraceRow.Type;

const isHarness = Schema.is(Harness);
// ClickHouse prints DateTime64(3) as 'YYYY-MM-DD hh:mm:ss.fff' in UTC.
export const traceTimestamp = (value: string) => {
  const iso = `${value.trim().replace(' ', 'T')}Z`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;
};

// Session keys are '<harness>:<native id>' for Claude and Codex. Collectors key
// Claude subagent calls under the parent conversation, and Codex subagents
// under their own thread; keep both conventions so sessions line up.
export const traceSessionId = (key: string) => {
  const claude = /^claude:([^:]+)(?::agent:.*)?$/.exec(key);
  if (claude) return claude[1];
  return key.startsWith('codex:') ? key.slice('codex:'.length) : key;
};

export const devicePlatform = (os: string) => {
  const name = os.trim().toLowerCase();
  return name.startsWith('mac') || name === 'darwin'
    ? 'darwin'
    : name.startsWith('win')
      ? 'win32'
      : name === ''
        ? 'unknown'
        : name;
};

export type TraceEvent = { readonly machine: string; readonly platform: string; readonly event: UsageEvent };

// The tracker's six harnesses only: adding a category is a compatibility event
// for every collector, so traces from other clients stay out (see README).
// Failed and empty calls are not accounting records either, as with collectors.
// `undefined` means the row must not be stored (and is withdrawn if it was).
export const traceEvent = (
  row: TraceRow,
  repository: (machine: string, cwd: string, reported: string) => string | null,
  policy: PricingPolicy,
  since: string,
): TraceEvent | undefined => {
  const timestamp = traceTimestamp(row.requested_at);
  if (!timestamp || timestamp < since || row.failed || !isHarness(row.harness)) return undefined;
  const cwd = row.cwd.trim();
  const subagentOfClaude = row.harness === 'claude' && row.session_key.includes(':agent:');
  const base: UsageEvent = {
    id: row.id,
    timestamp,
    harness: row.harness,
    model: row.model || 'unknown',
    project: cwd || 'Unknown project',
    repository: cwd || row.repository ? repository(row.machine, cwd, row.repository) : null,
    sessionId: traceSessionId(row.session_key),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: Math.min(row.reasoning_tokens, row.output_tokens),
    costUsd: 0,
    costKnown: false,
    // A Claude subagent's title is its first prompt; the parent's names the session.
    ...(row.title.trim() && !subagentOfClaude ? { sessionTitle: row.title.trim() } : {}),
  };
  if (!tokenTotal(base)) return undefined;
  const cacheWrite1h = Math.min(row.cache_write_1h_tokens, row.cache_write_tokens);
  const tier = row.service_tier.trim();
  return {
    machine: row.machine.trim(),
    platform: devicePlatform(row.machine_os),
    event: {
      ...base,
      ...estimateCost(base, cacheWrite1h, tier, policy),
      rawModel: base.model,
      model: resolveDisplayModel(base.model, policy),
      serviceTier: tier,
      cacheWrite1hTokens: cacheWrite1h,
    },
  };
};
