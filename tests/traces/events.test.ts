import { expect, test } from 'bun:test';
import { Result } from 'effect';
import { bundledPolicy } from '../../src/lib/server/usage/pricing';
import { traceEvent, traceSessionId, type TraceRow } from '../../src/lib/server/traces/events';
import { makeProjectResolver } from '../../src/lib/server/traces/projects';
import { traceDevice, traceSourceConfig } from '../../src/lib/server/traces/source';

// Shaped like traces.v_usage_events (013_usage_events.sql): tracker classes.
const row: TraceRow = {
  id: 'trace:0195a6d0-0000-7000-8000-000000000001',
  requested_at: '2026-11-18 09:21:35.401',
  session_key: 'claude:06677296-3a79-4217-a7fc-d4e641f14d8d',
  harness: 'claude',
  machine: 'morningstar',
  machine_os: 'windows',
  cwd: 'C:\\Users\\davis\\.t3\\worktrees\\my-token-tracker\\t3-1',
  repository: '',
  title: 'Fix the build',
  is_subagent: false,
  session_updated_at: '2026-11-18 09:30:00.000',
  model: 'claude-fable-5-2',
  service_tier: 'standard',
  failed: false,
  input_tokens: 2,
  output_tokens: 1993,
  cache_read_tokens: 256983,
  cache_write_tokens: 1304,
  cache_write_1h_tokens: 1304,
  reasoning_tokens: 141,
};
const pairs = [
  {
    machine: 'siva',
    path: '/home/davis/.t3/worktrees/my-token-tracker/t3-9',
    repository: 'github.com/davis7dotsh/token-tracker',
  },
  { machine: 'enceladus', path: '/home/davis/dev/app', repository: 'github.com/ben/app' },
  { machine: 'enceladus', path: '/home/davis/dev/plain', repository: 'local:/home/davis/dev/plain' },
];
const resolve = makeProjectResolver(pairs);
const since = '2026-10-15T00:00:00.000Z';

test('a trace row becomes the same accounting record a collector reports, under a stable ID', () => {
  const mapped = traceEvent(row, resolve, bundledPolicy, since);
  expect(mapped).toMatchObject({ machine: 'morningstar', platform: 'win32' });
  expect(mapped?.event).toMatchObject({
    id: row.id,
    timestamp: '2026-11-18T09:21:35.401Z',
    harness: 'claude',
    rawModel: 'claude-fable-5-2',
    sessionId: '06677296-3a79-4217-a7fc-d4e641f14d8d',
    project: row.cwd,
    repository: 'github.com/davis7dotsh/token-tracker',
    sessionTitle: 'Fix the build',
    inputTokens: 2,
    outputTokens: 1993,
    cacheReadTokens: 256983,
    cacheWriteTokens: 1304,
    cacheWrite1hTokens: 1304,
    reasoningTokens: 141,
    serviceTier: 'standard',
  });
  // Replays and later metadata produce the same identity and accounting.
  expect(
    traceEvent({ ...row, title: '', session_updated_at: '2026-11-19 00:00:00.000' }, resolve, bundledPolicy, since)
      ?.event,
  ).toMatchObject({ id: row.id, inputTokens: 2, cacheReadTokens: 256983 });
});

test('only the six harnesses, successful calls with tokens, and calls since the cutover are stored', () => {
  expect(traceEvent({ ...row, harness: 'gemini' }, resolve, bundledPolicy, since)).toBeUndefined();
  expect(traceEvent({ ...row, harness: 'tx9' }, resolve, bundledPolicy, since)).toBeUndefined();
  expect(traceEvent({ ...row, failed: true }, resolve, bundledPolicy, since)).toBeUndefined();
  expect(
    traceEvent({ ...row, harness: 'grok', machine: 'conflux/tx9-box' }, resolve, bundledPolicy, since),
  ).toBeUndefined();
  const empty = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_write_1h_tokens: 0,
  };
  expect(traceEvent({ ...row, ...empty }, resolve, bundledPolicy, since)).toBeUndefined();
  expect(traceEvent(row, resolve, bundledPolicy, '2026-11-18T09:21:35.402Z')).toBeUndefined();
  expect(traceEvent(row, resolve, bundledPolicy, '2026-11-18T09:21:35.401Z')).toBeDefined();
});

test('sessions follow collector conventions for subagents', () => {
  expect(traceSessionId('claude:abc:agent:a90')).toBe('abc');
  expect(traceSessionId('codex:p1:agent:evidence')).toBe('p1:agent:evidence');
  expect(traceSessionId('derived:ctx:v1:ff')).toBe('derived:ctx:v1:ff');
  const subagent = traceEvent({ ...row, session_key: 'claude:abc:agent:a90' }, resolve, bundledPolicy, since)?.event;
  expect(subagent?.sessionTitle).toBeUndefined();
});

test('projects resolve like a collector: reported remote, folder, T3 project, enclosing folder, else none', () => {
  expect(resolve('siva', '/x', 'git@github.com:pingdotgg/T3Code.git')).toBe('github.com/pingdotgg/t3code');
  expect(resolve('enceladus', '/home/davis/dev/app', '')).toBe('github.com/ben/app');
  expect(resolve('enceladus', '/home/davis/dev/app/packages/web', '')).toBe('github.com/ben/app');
  expect(resolve('helm', '/home/davis/dev/app/packages/web', '')).toBeNull();
  expect(resolve('servitor', '/Users/davis/.t3/worktrees/my-token-tracker/t3-2', '')).toBe(
    'github.com/davis7dotsh/token-tracker',
  );
  expect(resolve('enceladus', '/home/davis/dev/plain', '')).toBe('local:/home/davis/dev/plain');
  expect(resolve('siva', '/home/davis/.t3/scratch/2026-11-17-notes', '')).toBeNull();
  expect(resolve('siva', '/workspace', '')).toBeNull();
});

test('a machine keeps its collector device; new and unknown machines get stable trace devices', () => {
  const devices = [
    {
      id: 'old',
      name: 'Siva',
      platform: 'linux',
      lastSeen: '2026-01-01',
      eventCount: 1,
      revokedAt: null,
      needsReconnect: false,
    },
    {
      id: 'new',
      name: 'siva',
      platform: 'linux',
      lastSeen: '2026-11-01',
      eventCount: 1,
      revokedAt: null,
      needsReconnect: false,
    },
  ];
  expect(traceDevice(devices, 'siva', 'linux')).toEqual({ id: 'new', name: 'siva', platform: 'linux' });
  expect(traceDevice(devices, 'siva', 'linux', 'old')).toEqual({ id: 'old', name: 'Siva', platform: 'linux' });
  expect(traceDevice([{ ...devices[1], id: 'trace:europa', name: 'Europa Server' }], 'europa', 'linux')).toEqual({
    id: 'trace:europa',
    name: 'Europa Server',
    platform: 'linux',
  });
  expect(traceDevice(devices, 'Europa', 'linux')).toEqual({ id: 'trace:europa', name: 'Europa', platform: 'linux' });
  expect(traceDevice(devices, '', 'unknown')).toEqual({
    id: 'trace:unknown',
    name: 'Unknown machine',
    platform: 'unknown',
  });
  // Individual Grok trace calls use catalog rates instead of requiring collector reportedCostUsd.
  const grok = traceEvent(
    { ...row, harness: 'grok', model: 'grok-4.6', cache_write_tokens: 0, cache_write_1h_tokens: 0 },
    resolve,
    bundledPolicy,
    since,
  );
  expect(grok?.event.costKnown).toBe(true);
  expect(grok?.event.costUsd).toBeGreaterThan(0);
  // Remote plaintext HTTP trace URLs are rejected; loopback HTTP and HTTPS are allowed.
  expect(Result.isFailure(traceSourceConfig('/tmp', { TOKEN_TRACKER_TRACES_URL: 'http://10.0.0.5:8123' }))).toBe(true);
  expect(Result.isSuccess(traceSourceConfig('/tmp', { TOKEN_TRACKER_TRACES_URL: 'http://127.0.0.1:8123' }))).toBe(true);
  expect(Result.isSuccess(traceSourceConfig('/tmp', { TOKEN_TRACKER_TRACES_URL: 'https://ch.example.com' }))).toBe(
    true,
  );
});
