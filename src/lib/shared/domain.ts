import { Schema } from 'effect';

export const Harness = Schema.Literals(['claude', 'codex', 'pi']);
export const UsageRange = Schema.Literals(['today', '7d', '30d', '6m', '90d', 'all']);
const TokenCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const ApiCost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), {
    expected: 'an ISO timestamp with a timezone',
  }),
);

// Only accounting and session metadata cross this boundary. Prompts and replies
// are never retained by the collector or uploaded to another machine.
export const UsageEvent = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  timestamp: Timestamp,
  harness: Harness,
  model: Schema.String,
  rawModel: Schema.optionalKey(Schema.String),
  project: Schema.String,
  repository: Schema.NullOr(Schema.String),
  sessionId: Schema.String,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount,
  cacheWriteTokens: TokenCount,
  reasoningTokens: TokenCount,
  costUsd: ApiCost,
  costKnown: Schema.Boolean,
  serviceTier: Schema.optionalKey(Schema.String),
  cacheWrite1hTokens: Schema.optionalKey(TokenCount),
  deviceId: Schema.optionalKey(Schema.String),
});
export type UsageEvent = typeof UsageEvent.Type;

export const SourceStatus = Schema.Struct({
  harness: Harness,
  path: Schema.String,
  files: Schema.Number,
  events: Schema.Number,
  status: Schema.Literals(['missing', 'empty', 'ready', 'partial', 'error']),
  error: Schema.optionalKey(Schema.String),
});
export type SourceStatus = typeof SourceStatus.Type;

export const UsageResult = Schema.Struct({
  events: Schema.Array(UsageEvent),
  sources: Schema.Array(SourceStatus),
  warnings: Schema.Array(Schema.String),
  pricingUpdatedAt: Schema.String,
});
export type UsageResult = typeof UsageResult.Type;

export const UsageQuery = Schema.Struct({
  range: Schema.optionalKey(UsageRange),
  timezone: Schema.optionalKey(Schema.String),
  harnesses: Schema.optionalKey(Schema.Array(Schema.String)),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  projects: Schema.optionalKey(Schema.Array(Schema.String)),
  devices: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type UsageQuery = typeof UsageQuery.Type;

const totalFields = {
  tokens: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUSD: Schema.Number,
  unpricedTokens: Schema.Number,
  sessions: Schema.Number,
  requests: Schema.Number,
  cacheHitRate: Schema.Number,
};
export const Totals = Schema.Struct(totalFields);
export type Totals = typeof Totals.Type;
export const Breakdown = Schema.Struct({ name: Schema.String, ...totalFields });
export type Breakdown = typeof Breakdown.Type;
export const Session = Schema.Struct({
  id: Schema.String,
  harness: Harness,
  model: Schema.String,
  provider: Schema.String,
  project: Schema.String,
  repository: Schema.NullOr(Schema.String),
  deviceId: Schema.String,
  startedAt: Schema.String,
  lastActiveAt: Schema.String,
  ...totalFields,
});
export type Session = typeof Session.Type;
export const DashboardResponse = Schema.Struct({
  machine: Schema.String,
  generatedAt: Schema.String,
  timezone: Schema.String,
  range: UsageRange,
  period: Schema.Struct({ start: Schema.String, end: Schema.String }),
  totals: Totals,
  previous: Schema.NullOr(Totals),
  daily: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      tokens: Schema.Number,
      costUSD: Schema.Number,
      harnesses: Schema.Array(Breakdown),
    }),
  ),
  hourly: Schema.Array(
    Schema.Struct({
      start: Schema.String,
      end: Schema.String,
      tokens: Schema.Number,
      costUSD: Schema.Number,
      harnesses: Schema.Array(Breakdown),
    }),
  ),
  harnesses: Schema.Array(Breakdown),
  models: Schema.Array(Breakdown),
  providers: Schema.Array(Breakdown),
  projects: Schema.Array(Breakdown),
  devices: Schema.Array(Breakdown),
  sessions: Schema.Array(Session),
  filters: Schema.Struct({
    harnesses: Schema.Array(Schema.String),
    models: Schema.Array(Schema.String),
    selectedModels: Schema.optionalKey(Schema.Array(Schema.String)),
    providers: Schema.Array(Schema.String),
    projects: Schema.Array(Schema.String),
    devices: Schema.Array(Schema.String),
    modelProviders: Schema.Array(Schema.Struct({ model: Schema.String, provider: Schema.String })),
  }),
  sources: Schema.Array(SourceStatus),
  warnings: Schema.Array(Schema.String),
  pricing: Schema.Struct({ method: Schema.String, updatedAt: Schema.String }),
});
export type DashboardResponse = typeof DashboardResponse.Type;

export const DeviceRegistration = Schema.Struct({ id: Schema.String, name: Schema.String, platform: Schema.String });
export type DeviceRegistration = typeof DeviceRegistration.Type;
export const Device = Schema.Struct({
  ...DeviceRegistration.fields,
  lastSeen: Schema.NullOr(Schema.String),
  eventCount: Schema.Number,
});
export type Device = typeof Device.Type;
export const SyncBatch = Schema.Struct({
  device: DeviceRegistration,
  events: Schema.Array(UsageEvent),
  deletedIds: Schema.optionalKey(Schema.Array(Schema.String)),
  sources: Schema.optionalKey(Schema.Array(SourceStatus)),
  pricingUpdatedAt: Schema.optionalKey(Schema.String),
});
export type SyncBatch = typeof SyncBatch.Type;
export const SyncAck = Schema.Struct({
  accepted: Schema.Number,
  updated: Schema.Number,
  deleted: Schema.Number,
  receivedAt: Schema.String,
});
export type SyncAck = typeof SyncAck.Type;

export class CollectionError extends Schema.TaggedError<CollectionError>()('CollectionError', {
  message: Schema.String,
}) {}
