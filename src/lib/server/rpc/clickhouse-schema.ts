import { Schema } from 'effect';
import { UsageEvent } from '../../shared/domain';
import { provider } from '../../shared/provider';
import { text, type ClickHouseRow } from './clickhouse';

// ClickHouse has no in-place updates. Every write appends a row with a higher
// `version`; reads keep each record's latest version with argMax, and deletions
// append a tombstone (is_deleted = 1). ReplacingMergeTree drops superseded rows
// in the background, but reads never depend on merges having happened.
export const schemaStatements = (database: string) => [
  `CREATE DATABASE IF NOT EXISTS ${database}`,
  `CREATE TABLE IF NOT EXISTS ${database}.usage_events (
    device_id String,
    id String,
    timestamp DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(1)),
    -- The collector's original string, offset and precision intact, as SQLite
    -- keeps it in the payload. timestamp is its UTC value for sorting and windows.
    timestamp_raw String CODEC(ZSTD(1)),
    harness LowCardinality(String),
    model LowCardinality(String),
    raw_model LowCardinality(Nullable(String)),
    provider LowCardinality(String),
    project String CODEC(ZSTD(1)),
    repository Nullable(String) CODEC(ZSTD(1)),
    session_id String CODEC(ZSTD(1)),
    -- T64 suits token counters: they are not monotonic, so Delta gains little,
    -- while T64 strips the unused high bits of mostly small values.
    input_tokens UInt64 CODEC(T64, ZSTD(1)),
    output_tokens UInt64 CODEC(T64, ZSTD(1)),
    cache_read_tokens UInt64 CODEC(T64, ZSTD(1)),
    cache_write_tokens UInt64 CODEC(T64, ZSTD(1)),
    reasoning_tokens UInt64 CODEC(T64, ZSTD(1)),
    cache_write_1h_tokens Nullable(UInt64),
    requests Nullable(UInt64),
    cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
    reported_cost_usd Nullable(Float64),
    cost_known UInt8,
    service_tier LowCardinality(Nullable(String)),
    session_title Nullable(String) CODEC(ZSTD(1)),
    project_name Nullable(String) CODEC(ZSTD(1)),
    t3_thread_id Nullable(String) CODEC(ZSTD(1)),
    t3_thread_url Nullable(String) CODEC(ZSTD(1)),
    payload_hash String,
    pricing_snapshot String,
    is_deleted UInt8 DEFAULT 0,
    version UInt64 CODEC(Delta, ZSTD(1)),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX id_bloom id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX session_bloom session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX project_tokens project TYPE tokenbf_v1(8192, 3, 0) GRANULARITY 4,
    -- Dashboard reads scan a time range across every device.
    PROJECTION events_by_time (SELECT * ORDER BY timestamp, harness, device_id, id)
  )
  ENGINE = ReplacingMergeTree(version)
  PARTITION BY toYYYYMM(timestamp)
  ORDER BY (device_id, harness, timestamp, id)
  SETTINGS deduplicate_merge_projection_mode = 'rebuild'`,
  // Tables created before timestamp_raw existed gain it in place; their rows
  // read back with the empty-raw fallback in rowToEvent.
  `ALTER TABLE ${database}.usage_events ADD COLUMN IF NOT EXISTS timestamp_raw String CODEC(ZSTD(1)) AFTER timestamp`,
  `CREATE TABLE IF NOT EXISTS ${database}.devices (
    id String,
    name String,
    platform LowCardinality(String),
    token_hash String,
    last_seen Nullable(DateTime64(3, 'UTC')),
    sources String CODEC(ZSTD(3)),
    pricing_updated_at String,
    revoked_at Nullable(DateTime64(3, 'UTC')),
    version UInt64,
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
  )
  ENGINE = ReplacingMergeTree(version)
  ORDER BY id`,
];

// DateTime64 columns read and write `YYYY-MM-DD HH:MM:SS.mmm` in UTC. Values
// clamp to the type's 1900–2299 range, as ClickHouse would; `timestamp_raw`
// keeps the exact original.
const earliest = Date.UTC(1900, 0, 1);
const latest = Date.UTC(2299, 11, 31, 23, 59, 59, 999);
export const formatTimestamp = (iso: string) =>
  new Date(Math.min(Math.max(Date.parse(iso), earliest), latest)).toISOString().slice(0, 23).replace('T', ' ');
export const parseTimestamp = (value: string) => new Date(`${value.replace(' ', 'T')}Z`).toISOString();

// Versions split the UInt64 space: migrated rows sit in [1, 2^62) and live
// writes above 2^62, so a live correction or deletion always wins, even over a
// migrated record dated in the future.
const liveVersions = 2n ** 62n;
// Live versions are nanosecond-scale wall-clock values that never repeat or
// decrease within a process. They stay below 2^64 until the year 2407.
let lastVersion = 0n;
export const nextVersion = () => {
  const now = liveVersions + BigInt(Date.now()) * 1_000_000n;
  lastVersion = now > lastVersion ? now : lastVersion + 1n;
  return lastVersion;
};
// Migrated rows are versioned by their own timestamp: deterministic, so reruns
// write identical rows. Pre-1970 and absurdly distant timestamps clamp into range.
export const migrationVersion = (timestamp: string) => {
  const version = BigInt(Date.parse(timestamp)) * 1_000_000n;
  return version < 1n ? 1n : version >= liveVersions ? liveVersions - 1n : version;
};

export const eventToRow = (
  event: UsageEvent,
  deviceId: string,
  version: bigint,
  pricingSnapshot: string,
  payloadHash: string,
) => ({
  device_id: deviceId,
  id: event.id,
  timestamp: formatTimestamp(event.timestamp),
  timestamp_raw: event.timestamp,
  harness: event.harness,
  model: event.model,
  raw_model: event.rawModel ?? null,
  // A query convenience column only; it is never read back into an event.
  provider: provider(event.model),
  project: event.project,
  repository: event.repository,
  session_id: event.sessionId,
  input_tokens: event.inputTokens,
  output_tokens: event.outputTokens,
  cache_read_tokens: event.cacheReadTokens,
  cache_write_tokens: event.cacheWriteTokens,
  reasoning_tokens: event.reasoningTokens,
  cache_write_1h_tokens: event.cacheWrite1hTokens ?? null,
  requests: event.requests ?? null,
  cost_usd: event.costUsd,
  reported_cost_usd: event.reportedCostUsd ?? null,
  cost_known: event.costKnown ? 1 : 0,
  service_tier: event.serviceTier ?? null,
  session_title: event.sessionTitle ?? null,
  project_name: event.projectName ?? null,
  t3_thread_id: event.t3ThreadId ?? null,
  t3_thread_url: event.t3ThreadUrl ?? null,
  payload_hash: payloadHash,
  pricing_snapshot: pricingSnapshot,
  is_deleted: 0,
  version,
});
export type EventRow = ReturnType<typeof eventToRow>;
// Every stored column except the dedupe key and bookkeeping.
export const eventColumns = Object.keys(
  eventToRow(
    {
      id: '-',
      timestamp: '1970-01-01T00:00:00.000Z',
      harness: 'claude',
      model: '',
      project: '',
      repository: null,
      sessionId: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      costKnown: false,
    },
    '',
    0n,
    '',
    '',
  ),
).filter((column) => !['device_id', 'id', 'version'].includes(column));

const present = (value: unknown) => value !== null && value !== undefined;
const optional = (key: string, value: unknown, coerce: (value: unknown) => unknown = text) =>
  present(value) ? { [key]: coerce(value) } : {};
const decodeEvent = Schema.decodeUnknownSync(UsageEvent);

// JSONEachRow returns UInt64 values as strings and Nullable columns as null.
// Absent optional fields stay absent, so decoded events equal the originals.
export const rowToEvent = (row: ClickHouseRow) =>
  decodeEvent({
    ...optional('sessionTitle', row.session_title),
    ...optional('projectName', row.project_name),
    ...optional('t3ThreadId', row.t3_thread_id),
    ...optional('t3ThreadUrl', row.t3_thread_url),
    id: row.id,
    // Rows from before timestamp_raw was added read it as empty; use the UTC value.
    timestamp: text(row.timestamp_raw) || parseTimestamp(text(row.timestamp)),
    harness: row.harness,
    model: row.model,
    ...optional('rawModel', row.raw_model),
    project: row.project,
    repository: present(row.repository) ? row.repository : null,
    sessionId: row.session_id,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    costUsd: Number(row.cost_usd),
    ...optional('reportedCostUsd', row.reported_cost_usd, Number),
    costKnown: Number(row.cost_known) === 1,
    ...optional('serviceTier', row.service_tier),
    ...optional('cacheWrite1hTokens', row.cache_write_1h_tokens, Number),
    ...optional('requests', row.requests, Number),
    deviceId: row.device_id,
  });

// Reads the latest version of each (device_id, id) record. FINAL cannot do this
// for usage_events: the sorting key includes timestamp, which a correction can
// change, so superseded versions need not share a key with their replacement.
// Aggregates skip NULLs, so each value is wrapped in a tuple: a correction that
// clears an optional field must win over an older non-null value.
export const latestEvents = (columns: readonly string[], where = '1') =>
  `SELECT device_id, id, ${columns.map((column) => `argMax(tuple(${column}), version).1 AS ${column}`).join(', ')}
  FROM usage_events WHERE ${where} GROUP BY device_id, id`;
