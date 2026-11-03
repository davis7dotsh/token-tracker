import { expect, test } from 'bun:test';
import {
  eventToRow,
  formatTimestamp,
  migrationVersion,
  nextVersion,
  parseTimestamp,
  rowToEvent,
  schemaStatements,
} from '../../src/lib/server/rpc/clickhouse-schema';
import type { UsageEvent } from '../../src/lib/shared/domain';

const minimal: UsageEvent = {
  id: 'request-1',
  timestamp: '2026-10-03T01:00:00.000Z',
  harness: 'codex',
  model: 'gpt-5.5',
  project: '/work/app',
  repository: null,
  sessionId: 'session-1',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheWriteTokens: 0,
  reasoningTokens: 10,
  costUsd: 0,
  costKnown: false,
  deviceId: 'laptop',
};
const full: UsageEvent = {
  ...minimal,
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  rawModel: 'anthropic/claude-sonnet-4-6',
  repository: 'github.com/ben/app',
  costUsd: 0.0123,
  reportedCostUsd: 0.02,
  costKnown: true,
  serviceTier: 'priority',
  cacheWrite1hTokens: 7,
  requests: 3,
  sessionTitle: 'Fix the build',
  projectName: 'app',
  t3ThreadId: 'thread-1',
  t3ThreadUrl: 't3://thread-1',
};

// JSONEachRow quotes UInt64 values; mimic what ClickHouse sends back.
const viaClickHouse = (event: UsageEvent) => {
  const row = eventToRow(event, 'laptop', nextVersion(), 'pricing-1', 'hash');
  return rowToEvent({
    ...row,
    input_tokens: String(row.input_tokens),
    requests: row.requests === null ? null : String(row.requests),
    version: row.version.toString(),
  });
};

test('events round-trip through ClickHouse rows', () => {
  expect(viaClickHouse(full)).toEqual(full);
  const decoded = viaClickHouse(minimal);
  expect(decoded).toEqual(minimal);
  expect(Object.keys(decoded)).not.toContain('rawModel');
  expect(Object.keys(decoded)).not.toContain('sessionTitle');
  expect(eventToRow(full, 'laptop', 1n, '', '').provider).toBe('anthropic');
});

test('events keep their original timestamp string', () => {
  const offset = { ...full, timestamp: '2026-10-03T03:02:03.400+02:00' };
  expect(viaClickHouse(offset)).toEqual(offset);
  const row = eventToRow(offset, 'laptop', 1n, '', '');
  expect(row.timestamp).toBe('2026-10-03 01:02:03.400');
  expect(rowToEvent({ ...row, timestamp_raw: '' }).timestamp).toBe('2026-10-03T01:02:03.400Z');
});

test('timestamps convert between ISO and DateTime64 text', () => {
  expect(formatTimestamp('2026-10-03T01:02:03.456Z')).toBe('2026-10-03 01:02:03.456');
  expect(formatTimestamp('2026-10-03T03:02:03.4+02:00')).toBe('2026-10-03 01:02:03.400');
  expect(parseTimestamp('2026-10-03 01:02:03.456')).toBe('2026-10-03T01:02:03.456Z');
  expect(parseTimestamp(formatTimestamp('2026-01-31T23:59:59.999Z'))).toBe('2026-01-31T23:59:59.999Z');
  expect(formatTimestamp('+012026-01-01T00:00:00.000Z')).toBe('2299-12-31 23:59:59.999');
  expect(formatTimestamp('1800-01-01T00:00:00.000Z')).toBe('1900-01-01 00:00:00.000');
});

test('migration versions are deterministic and older than live versions', () => {
  expect(migrationVersion(minimal.timestamp)).toBe(migrationVersion(minimal.timestamp));
  const first = nextVersion();
  const second = nextVersion();
  expect(second).toBeGreaterThan(first);
  expect(migrationVersion(new Date().toISOString())).toBeLessThan(nextVersion());
  expect(migrationVersion('2090-01-01T00:00:00.000Z')).toBeLessThan(nextVersion());
  expect(migrationVersion('+275760-09-13T00:00:00.000Z')).toBeLessThan(nextVersion());
  expect(migrationVersion('1960-01-01T00:00:00.000Z')).toBe(1n);
  expect(nextVersion()).toBeLessThan(2n ** 64n);
});

test('schema uses versioned, compressed, partitioned tables', () => {
  const ddl = schemaStatements('token_tracker').join('\n');
  for (const fragment of ['ReplacingMergeTree(version)', 'DoubleDelta', 'LowCardinality', 'PARTITION BY', 'PROJECTION'])
    expect(ddl).toContain(fragment);
});
