import { expect, test } from 'bun:test';
import { bucketSelection, deltaOf, timeBuckets } from '../../src/lib/client/usage-workbench';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';
import type { DashboardResponse } from '../../src/lib/shared/domain';

const sample = (range: DashboardResponse['range'], now: string, timezone = 'UTC') =>
  buildDashboard({ events: [], sources: [], warnings: [], pricingUpdatedAt: now }, { range, timezone }, new Date(now));

test.each(['90d', '6m'] as const)('%s weeks start on Mondays, clip at both ends, and preserve totals', (range) => {
  const d = sample(range, '2026-11-13T12:00:00Z');
  const data = {
    ...d,
    daily: d.daily.slice(-9).map((b) => ({
      ...b,
      tokens: 4,
      costUSD: 1,
      models: [{ name: 'demo', tokens: 4, costUSD: 1, unpricedTokens: 0 }],
    })),
  };
  const buckets = timeBuckets(data, 'models');
  expect(buckets.map((b) => [b.key, b.label, b.tokens, b.partial])).toEqual([
    ['2026-11-05', 'Nov 5 – Nov 8', 16, false],
    ['2026-11-09', 'Nov 9 – Nov 13', 20, true],
  ]);
  expect(buckets[1].rows.get('demo')).toEqual({ tokens: 20, costUSD: 5, unpricedTokens: 0 });
  expect(timeBuckets(data, 'models')).toBe(buckets);
  expect(timeBuckets(data, 'providers')[1].rows.size).toBe(0);
});

test.each(['7d', '30d'] as const)('%s keeps daily keys and treats stale selections as the whole range', (range) => {
  const d = sample(range, '2026-11-13T12:00:00Z');
  const buckets = timeBuckets(d, 'devices');
  expect(buckets.map((b) => b.key)).toEqual(d.daily.map((b) => b.date));
  const first = buckets[0],
    last = buckets[buckets.length - 1];
  expect(bucketSelection(buckets, 'stale')).toEqual(bucketSelection(buckets, undefined));
  expect(bucketSelection(buckets, 'stale')).toMatchObject({ bucket: undefined, previous: last.key, next: first.key });
  expect(bucketSelection(buckets, first.key)).toMatchObject({
    bucket: first,
    previous: undefined,
    next: buckets[1].key,
  });
  expect(bucketSelection(buckets, last.key)).toMatchObject({ next: undefined });
});

test('hourly selection survives the repeated DST hour and marks only the in-progress hour', () => {
  const d = sample('today', '2026-11-01T06:30:00Z', 'America/New_York');
  const buckets = timeBuckets(d, 'models');
  expect(buckets).toHaveLength(25);
  expect(buckets.map((b) => b.key)).toEqual(d.hourly.map((b) => b.start));
  expect(buckets[1].label).not.toBe(buckets[2].label);
  expect(buckets.filter((b) => b.partial)).toEqual([buckets[2]]);
});

test('delta keeps magnitude separate from direction and distinguishes new usage from missing data', () => {
  expect(deltaOf(123, 100)).toEqual({ text: '23%', direction: 'up' });
  expect(deltaOf(77, 100)).toEqual({ text: '23%', direction: 'down' });
  expect(deltaOf(5, 0)).toEqual({ text: 'new', direction: 'up' });
  expect(deltaOf(0, 0)).toEqual({ text: '0%', direction: 'flat' });
  expect(deltaOf(5, undefined)).toBeUndefined();
});
