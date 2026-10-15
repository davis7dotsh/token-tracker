import { expect, test } from 'bun:test';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';
import type { UsageEvent, UsageQuery } from '../../src/lib/shared/domain';

test('dashboard filter revisits reuse bounded aggregates and retain recently used filters', () => {
  const events: UsageEvent[] = [
    {
      id: 'request',
      timestamp: '2026-10-15T08:00:00Z',
      harness: 'codex',
      model: 'test-model',
      project: '/work/app',
      repository: null,
      sessionId: 'session',
      deviceId: 'device',
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      costKnown: true,
    },
  ];
  const data = { events, sources: [], warnings: [], pricingUpdatedAt: 'test' };
  const now = new Date('2026-10-15T12:00:00Z');
  const queries: UsageQuery[] = [
    { range: 'all' },
    { range: 'all', harnesses: ['codex'] },
    { range: 'all', harnesses: ['claude'] },
    { range: 'all', models: ['test-model'] },
    { range: 'all', models: ['missing'] },
    { range: 'all', projects: ['/work/app'] },
    { range: 'all', devices: ['device'] },
    { range: 'all', devices: ['missing'] },
  ];
  const first = queries.map((query) => buildDashboard(data, query, now));
  for (const [index, query] of queries.entries()) {
    const revisited = buildDashboard(data, query, now);
    expect(revisited.sessions).toBe(first[index].sessions);
    expect(revisited).toEqual(buildDashboard({ ...data, events: [...events] }, query, now));
  }
  expect(buildDashboard(data, queries[0], now).sessions).toBe(first[0].sessions);
  buildDashboard(data, { range: 'all', providers: ['missing'] }, now);
  expect(buildDashboard(data, queries[0], now).sessions).toBe(first[0].sessions);
  expect(buildDashboard(data, queries[1], now).sessions).not.toBe(first[1].sessions);
});
