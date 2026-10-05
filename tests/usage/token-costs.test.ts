import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { DashboardResponse, type UsageEvent, type UsageQuery } from '../../src/lib/shared/domain';
import type { PricingPolicy } from '../../src/lib/shared/pricing';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';

const now = new Date('2026-10-05T12:00:00.000Z');
const policy: PricingPolicy = {
  revision: 'exact-fixture',
  catalog: {
    updatedAt: '2026-10-05',
    source: 'test',
    models: {
      catalog: {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000004,
        cache_read_input_token_cost: 0.000001,
        cache_creation_input_token_cost: 0.000005,
      },
    },
  },
  rules: [
    {
      model: 'custom',
      kind: 'rates',
      nickname: 'Paid model',
      rates: {
        inputPerMillion: 2,
        outputPerMillion: 8,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 2.5,
        cacheWrite1hPerMillion: 4,
      },
    },
    { model: 'proxy', kind: 'alias', target: 'custom' },
    { model: 'free', kind: 'free' },
    { model: 'partial', kind: 'rates', rates: { inputPerMillion: 3, outputPerMillion: 12 } },
  ],
};
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'event',
  timestamp: '2026-10-05T10:00:00.000Z',
  harness: 'codex',
  model: 'Paid model',
  rawModel: 'custom',
  project: '/work/app',
  repository: 'github.com/ben/app',
  sessionId: 'session',
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 400_000,
  cacheWrite1hTokens: 100_000,
  reasoningTokens: 100_000,
  costUsd: 8.15,
  costKnown: true,
  ...overrides,
});
const dashboard = (events: readonly UsageEvent[], query: UsageQuery = { range: 'today', timezone: 'UTC' }) =>
  buildDashboard(
    { events, sources: [], warnings: [], pricingUpdatedAt: policy.catalog.updatedAt },
    query,
    now,
    'Test machine',
    policy,
  );
const costs = (response: DashboardResponse) => {
  if (!response.tokenCosts) throw new Error('Token category costs must be supplied by a new dashboard.');
  return response.tokenCosts;
};
const categoryKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const allocatedCost = (response: DashboardResponse) => {
  const parts = costs(response);
  return categoryKeys.reduce((sum, key) => sum + parts[key].costUSD, parts.unattributedCostUSD);
};

describe('dashboard token category costs', () => {
  test('uses the exact custom policy and alias identity, combines cache TTL costs, and keeps free tokens priced', () => {
    const response = dashboard([
      event(),
      event({
        id: 'proxy',
        rawModel: 'proxy',
        inputTokens: 500_000,
        outputTokens: 250_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheWrite1hTokens: 0,
        reasoningTokens: 50_000,
        costUsd: 3.75,
      }),
      event({ id: 'free', model: 'free', rawModel: 'free', costUsd: 0, cacheWrite1hTokens: undefined }),
    ]);
    const parts = costs(response);
    expect(parts.input.costUSD).toBeCloseTo(3, 12);
    expect(parts.output.costUSD).toBeCloseTo(6, 12);
    expect(parts.cacheRead.costUSD).toBeCloseTo(1.25, 12);
    expect(parts.cacheWrite.costUSD).toBeCloseTo(1.65, 12);
    expect(categoryKeys.map((key) => parts[key].unavailableTokens)).toEqual([0, 0, 0, 0]);
    expect(parts.unattributedCostUSD).toBe(0);
    expect(response.totals.tokens).toBe(9_250_000);
    expect(response.totals.reasoningTokens).toBe(250_000);
    expect(response.totals.costUSD).toBeCloseTo(11.9, 12);
    expect(allocatedCost(response)).toBeCloseTo(response.totals.costUSD, 12);
  });

  test('does not expose partial currency estimates for events missing an active cache rate', () => {
    const response = dashboard([event({ model: 'partial', rawModel: 'partial', costKnown: false, costUsd: 0 })]);
    expect(costs(response)).toEqual({
      input: { costUSD: 0, unavailableTokens: 1_000_000 },
      output: { costUSD: 0, unavailableTokens: 500_000 },
      cacheRead: { costUSD: 0, unavailableTokens: 2_000_000 },
      cacheWrite: { costUSD: 0, unavailableTokens: 400_000 },
      unattributedCostUSD: 0,
    });
    expect(response.totals).toMatchObject({ tokens: 3_900_000, unpricedTokens: 3_900_000, costUSD: 0 });
  });

  test('missing rates for unused cache buckets do not make an otherwise priced event unavailable', () => {
    const response = dashboard([
      event({
        model: 'partial',
        rawModel: 'partial',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: undefined,
        reasoningTokens: 5,
        costUsd: 0.00027,
      }),
    ]);
    expect(costs(response).input.costUSD).toBeCloseTo(0.00003, 12);
    expect(costs(response).output.costUSD).toBeCloseTo(0.00024, 12);
    expect(costs(response).cacheRead).toEqual({ costUSD: 0, unavailableTokens: 0 });
    expect(costs(response).cacheWrite).toEqual({ costUSD: 0, unavailableTokens: 0 });
    expect(response.totals).toMatchObject({ tokens: 30, unpricedTokens: 0, costUSD: 0.00027 });
  });

  test('keeps native Grok and legacy costs unattributed when per-category pricing cannot be established', () => {
    const native = event({
      id: 'native',
      harness: 'grok',
      model: 'catalog',
      rawModel: 'catalog',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 250,
      cacheWriteTokens: 100,
      cacheWrite1hTokens: 0,
      reasoningTokens: 100,
      serviceTier: '',
      costUsd: 0.00475,
      reportedCostUsd: 0.00475,
    });
    const legacy = event({
      id: 'legacy',
      model: 'catalog',
      rawModel: 'catalog',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: undefined,
      reasoningTokens: 100,
      costUsd: 0.00425,
    });
    const response = dashboard([native, legacy, event({ id: 'missing-ttl', cacheWrite1hTokens: undefined })]);
    const parts = costs(response);
    expect(categoryKeys.map((key) => parts[key].costUSD)).toEqual([0, 0, 0, 0]);
    expect(categoryKeys.map((key) => parts[key].unavailableTokens)).toEqual([1_002_000, 501_000, 2_000_500, 400_100]);
    expect(parts.unattributedCostUSD).toBeCloseTo(8.159, 12);
    expect(response.totals.unpricedTokens).toBe(0);
    expect(allocatedCost(response)).toBeCloseTo(response.totals.costUSD, 12);
  });

  test('preserves a known total that disagrees with inferred prices instead of inventing a category split', () => {
    const response = dashboard([event({ costUsd: 10 })]);
    expect(response.totals.costUSD).toBe(10);
    expect(costs(response).unattributedCostUSD).toBe(10);
    expect(categoryKeys.map((key) => costs(response)[key].costUSD)).toEqual([0, 0, 0, 0]);
    expect(categoryKeys.map((key) => costs(response)[key].unavailableTokens)).toEqual([
      1_000_000, 500_000, 2_000_000, 400_000,
    ]);
    expect(allocatedCost(response)).toBe(10);
  });

  test('category costs follow the same device, project, model, harness, and timezone boundaries as totals', () => {
    const selected = event({ deviceId: 'laptop', timestamp: '2026-10-05T06:00:00.000Z' });
    const response = dashboard(
      [
        selected,
        event({ id: 'wrong-device', deviceId: 'desktop' }),
        event({ id: 'wrong-project', deviceId: 'laptop', repository: 'github.com/ben/other', project: '/work/other' }),
        event({ id: 'wrong-harness', deviceId: 'laptop', harness: 'claude' }),
        event({ id: 'wrong-model', deviceId: 'laptop', model: 'Other model' }),
        event({ id: 'previous-day', deviceId: 'laptop', timestamp: '2026-10-05T03:59:59.999Z' }),
        event({ id: 'future', deviceId: 'laptop', timestamp: '2026-10-05T12:00:00.001Z' }),
      ],
      {
        range: 'today',
        timezone: 'America/New_York',
        devices: ['laptop'],
        projects: ['github.com/ben/app'],
        harnesses: ['codex'],
        models: ['Paid model'],
        providers: ['unknown'],
      },
    );
    expect(response.totals).toMatchObject({ tokens: 3_900_000, costUSD: 8.15 });
    expect(response.previous?.tokens).toBe(3_900_000);
    expect(allocatedCost(response)).toBeCloseTo(8.15, 12);
    expect(costs(response).input.costUSD).toBe(2);
    expect(costs(response).unattributedCostUSD).toBe(0);
  });

  test('empty and zero-token dashboards provide finite zero costs', () => {
    const zero = event({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
    for (const response of [dashboard([]), dashboard([zero]), dashboard([event()], { range: 'today', models: [] })]) {
      expect(costs(response)).toEqual({
        input: { costUSD: 0, unavailableTokens: 0 },
        output: { costUSD: 0, unavailableTokens: 0 },
        cacheRead: { costUSD: 0, unavailableTokens: 0 },
        cacheWrite: { costUSD: 0, unavailableTokens: 0 },
        unattributedCostUSD: 0,
      });
      expect(response.totals.costUSD).toBe(0);
    }
  });

  test('the RPC response schema preserves category costs and still accepts older responses without them', () => {
    const response = dashboard([event()]);
    const encoded = Schema.encodeSync(DashboardResponse)(response);
    const decoded = Schema.decodeUnknownSync(DashboardResponse)(JSON.parse(JSON.stringify(encoded)));
    expect(decoded.tokenCosts).toEqual(response.tokenCosts);
    const { tokenCosts: _tokenCosts, ...legacy } = response;
    expect(Schema.decodeUnknownSync(DashboardResponse)(legacy).tokenCosts).toBeUndefined();
    expect(Schema.decodeUnknownSync(DashboardResponse)(legacy).totals).toEqual(response.totals);
  });
});
