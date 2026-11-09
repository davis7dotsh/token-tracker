import { expect, test } from 'bun:test';
import { buildDashboardSnapshot } from '../../src/lib/server/usage/dashboard';
import { bundledPolicy } from '../../src/lib/server/usage/pricing';
import type { UsageEvent, UsageQuery } from '../../src/lib/shared/domain';

// Compare a dense interleaved history to its independent, losslessly scaled
// sparse equivalent. The latter always takes the original per-record path.
test('dense rollups keep exact rolling edges, non-hour local boundaries, metadata, project discovery and pricing', () => {
  const base: UsageEvent = {
    id: 'a',
    harness: 'codex',
    deviceId: 'hub',
    model: 'rollup-fixture',
    project: '/test/repo',
    repository: 'org/repo',
    sessionId: 'a',
    timestamp: '2026-10-25T18:05:00.000Z',
    inputTokens: 2,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    reasoningTokens: 1,
    serviceTier: '',
    cacheWrite1hTokens: 0,
    costKnown: true,
    costUsd: 10,
    requests: 2,
    projectName: 'Repo',
  };
  const changes: Partial<UsageEvent>[][] = [
    [{}, { id: 'b', sessionId: 'b', timestamp: '2026-10-25T18:25:00.000Z', sessionTitle: 'Original' }],
    [
      { id: 'c', timestamp: '2026-11-01T18:05:00.000Z', sessionTitle: 'Old', t3ThreadId: 'bound' },
      {
        id: 'd',
        sessionId: 'b',
        timestamp: '2026-11-01T18:25:00.000Z',
        project: '/test/other',
        repository: null,
        costKnown: false,
        costUsd: 0,
      },
      { id: 'e', sessionId: '', timestamp: '2026-11-01T18:27:00.000Z', model: 'unknown', deviceId: 'other' },
    ],
    [
      { id: 'f', timestamp: '2026-11-08T18:03:00.000Z', sessionTitle: 'New', t3ThreadUrl: 'new-url' },
      { id: 'g', timestamp: '2026-11-08T18:08:00.000Z', sessionId: 'b' },
      { id: 'h', timestamp: '2026-11-08T18:23:00.000Z', sessionId: '', repository: null, project: '/hidden' },
    ],
  ];
  const repeats = 100;
  const dense = changes.flatMap((group) =>
    Array.from({ length: repeats }, (_, i) => group.map((e) => ({ ...base, ...e, id: `${i}:${e.id ?? 'a'}` }))).flat(),
  );
  const sparse = changes.flat().map((e) => {
    const row = { ...base, ...e };
    return {
      ...row,
      inputTokens: row.inputTokens * repeats,
      outputTokens: row.outputTokens * repeats,
      cacheReadTokens: row.cacheReadTokens * repeats,
      cacheWriteTokens: row.cacheWriteTokens * repeats,
      reasoningTokens: row.reasoningTokens * repeats,
      requests: (row.requests ?? 1) * repeats,
      costUsd: row.costUsd * repeats,
    };
  });
  const policy = {
    ...bundledPolicy,
    rules: [
      {
        model: 'rollup-fixture',
        kind: 'rates' as const,
        rates: { inputPerMillion: 1e6, outputPerMillion: 1e6, cacheReadPerMillion: 1e6, cacheWritePerMillion: 1e6 },
      },
    ],
  };
  const metadata = { sources: [], warnings: [], pricingUpdatedAt: '' };
  const queries: UsageQuery[] = [
    { range: 'all' },
    { range: 'today' },
    { range: '7d' },
    { range: '30d', excludedProjects: ['/hidden'] },
    { range: 'all', models: ['unknown'] },
    { range: '7d', devices: ['other'] },
  ];
  for (const timezone of ['America/New_York', 'Asia/Kathmandu'])
    for (const query of queries) {
      for (const date of [
        '2026-11-08T19:00:00.000Z',
        '2026-11-08T18:23:00.000Z',
        '2026-11-08T18:05:00.000Z',
        '2026-11-01T18:25:00.000Z',
      ]) {
        const at = (events: UsageEvent[]) =>
          buildDashboardSnapshot({ ...metadata, events }, { ...query, timezone }, new Date(date), 'fixture', policy);
        expect(at(dense)).toEqual(at(sparse));
      }
    }
  const at = (events: UsageEvent[]) =>
    buildDashboardSnapshot(
      { ...metadata, events },
      { range: 'all' },
      new Date('2026-11-09T00:00:00.000Z'),
      'fixture',
      policy,
    ).response;
  const before = at(dense);
  const corrected = dense.slice();
  // Same anchor/end and length; a middle correction must break block reuse.
  corrected[50] = { ...corrected[50], inputTokens: corrected[50].inputTokens + 11 };
  expect(at(corrected).totals.tokens).toBe(before.totals.tokens + 11);
  const rescaled = at(sparse);
  const prefix = { ...base, sessionId: '', timestamp: '2026-10-24T00:00:00.000Z' };
  expect(at([prefix, ...dense]).sessions).toEqual(rescaled.sessions);
});
