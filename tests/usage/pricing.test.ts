import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { PricingRule, type PricingPolicy } from '../../src/lib/shared/pricing';
import type { UsageEvent } from '../../src/lib/shared/domain';
import {
  bundledPolicy,
  estimateCost,
  repriceEvent,
  resolveDisplayModel,
  validatePricingRules,
} from '../../src/lib/server/usage/pricing';
import {
  decodeUpstreamPrices,
  deletePricingRule,
  installPricingPolicy,
  loadPricing,
  PRICING_DOWNLOAD,
  pricingRefreshDue,
  refreshPricing,
  setPricingRule,
} from '../../src/lib/server/usage/pricing-runtime';
import { eventDigest } from '../../src/cli/checkpoint';

const directories: string[] = [];
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-price-'));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'request',
  timestamp: '2026-10-03T00:00:00Z',
  harness: 'codex',
  model: 'quasar-alpha',
  project: '/work/app',
  repository: null,
  sessionId: 'session',
  inputTokens: 10_000,
  outputTokens: 1_000,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 0,
  reasoningTokens: 800,
  costUsd: 0,
  costKnown: false,
  serviceTier: '',
  cacheWrite1hTokens: 0,
  ...overrides,
});
const policy = (rules: readonly (typeof PricingRule.Type)[]): PricingPolicy => ({
  ...bundledPolicy,
  rules,
  revision: 'test-rules',
});

test('a confirmed alias uses canonical display/grouping and inherits context/tier pricing without losing raw identity', () => {
  const pricing = policy([{ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }]);
  const raw = event({ inputTokens: 200_000, cacheReadTokens: 100_000, outputTokens: 100, serviceTier: 'priority' });
  const expected = estimateCost({ ...raw, model: 'gpt-6.1-sol' }, 0, 'priority');
  const repriced = repriceEvent(raw, pricing);
  expect(repriced).toMatchObject({ model: 'gpt-6.1-sol', rawModel: 'quasar-alpha', costKnown: true });
  expect(repriced.costUsd).toBeCloseTo(expected.costUsd, 12);
  expect(repriced.id).toBe(raw.id);
  expect(repriced.inputTokens).toBe(raw.inputTokens);
  expect(resolveDisplayModel('quasar-alpha', pricing)).toBe('gpt-6.1-sol');
});

test('custom per-million rates cover each bucket once and missing cache rates stay unknown', () => {
  const rates = {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
    cacheWrite1hPerMillion: 4,
  };
  const pricing = policy([{ model: 'quasar-alpha', kind: 'rates', nickname: 'My model', rates }]);
  const raw = event({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
    cacheWrite1hTokens: 400_000,
  });
  expect(repriceEvent(raw, pricing)).toMatchObject({ model: 'My model', rawModel: 'quasar-alpha', costKnown: true });
  expect(repriceEvent(raw, pricing).costUsd).toBeCloseTo(13.3, 12);
  const missingCache = policy([
    { model: 'quasar-alpha', kind: 'rates', rates: { inputPerMillion: 2, outputPerMillion: 8 } },
  ]);
  expect(repriceEvent(raw, missingCache)).toMatchObject({ costKnown: false, costUsd: 0 });
  expect(repriceEvent({ ...raw, serviceTier: 'priority' }, pricing).costUsd).toBeCloseTo(13.3, 12);
  expect(repriceEvent({ ...raw, serviceTier: 'unknown-new-tier' }, pricing).costUsd).toBeCloseTo(13.3, 12);
  const { serviceTier: _tier, ...legacyNoWrites } = event();
  expect(repriceEvent(legacyNoWrites, pricing)).toMatchObject({ costKnown: true, model: 'My model' });
});

test('explicit zero rates and a free rule are distinct from omitted prices', () => {
  const zero = policy([
    {
      model: 'quasar-alpha',
      kind: 'rates',
      rates: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 },
    },
  ]);
  expect(repriceEvent(event(), zero)).toMatchObject({ costKnown: true, costUsd: 0 });
  const free = policy([{ model: 'quasar-alpha', kind: 'free' }]);
  expect(repriceEvent(event({ serviceTier: 'unknown-new-tier', cacheWriteTokens: 500 }), free)).toMatchObject({
    costKnown: true,
    costUsd: 0,
  });
});

test('legacy reported costs survive insufficient metadata while metadata upgrades trigger one-time sync', () => {
  const pricing = policy([{ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }]);
  const { serviceTier, cacheWrite1hTokens, ...legacy } = event({ costKnown: true, costUsd: 9 });
  expect(repriceEvent(legacy, pricing)).toMatchObject({ model: 'gpt-6.1-sol', costKnown: true, costUsd: 9 });
  const upgraded = { ...legacy, serviceTier: serviceTier ?? '', cacheWrite1hTokens: cacheWrite1hTokens ?? 0 };
  expect(repriceEvent(upgraded, pricing).costUsd).not.toBe(9);
  expect(eventDigest(upgraded)).not.toBe(eventDigest(legacy));
  expect(eventDigest(upgraded)).toBe(eventDigest({ ...upgraded }));
});

test('aliases reject nonexistent models, cycles, duplicate rules and fuzzy guesses', () => {
  expect(
    validatePricingRules(bundledPolicy.catalog, [{ model: 'one', kind: 'alias', target: 'missing-target' }]),
  ).toContain('no known');
  expect(
    validatePricingRules(bundledPolicy.catalog, [
      { model: 'one', kind: 'alias', target: 'two' },
      { model: 'two', kind: 'alias', target: 'one' },
    ]),
  ).toContain('cycle');
  expect(
    validatePricingRules(bundledPolicy.catalog, [
      { model: 'one', kind: 'free' },
      { model: 'one', kind: 'free' },
    ]),
  ).toContain('one pricing');
  expect(estimateCost(event({ model: 'gpt-6.1-sol-probably' })).costKnown).toBe(false);
  expect(estimateCost(event({ model: 'constructor' })).costKnown).toBe(false);
});

test('disk loading is read-only and durable edits serialize without lost rules', async () => {
  const directory = await temporary();
  const absent = join(directory, 'not-created');
  const initial = await Effect.runPromise(loadPricing(absent));
  expect(initial.info.rules).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
  const [alias] = await Promise.all([
    Effect.runPromise(setPricingRule({ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }, directory)),
    Effect.runPromise(setPricingRule({ model: 'another-model', kind: 'free' }, directory)),
  ]);
  const saved = await Effect.runPromise(loadPricing(directory));
  expect(saved.info.rules).toHaveLength(2);
  expect(saved.policy.revision).not.toBe(initial.policy.revision);
  expect(alias.info.rules.some((rule) => rule.model === 'quasar-alpha')).toBe(true);
  expect((await stat(join(directory, 'pricing-state.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect(saved.info.checkedAt).toBeNull();
  const invalid = await Effect.runPromiseExit(
    setPricingRule({ model: 'quasar-alpha', kind: 'alias', target: 'missing-target' }, directory),
  );
  expect(invalid._tag).toBe('Failure');
  expect((await Effect.runPromise(loadPricing(directory))).policy.revision).toBe(saved.policy.revision);
  await Effect.runPromise(deletePricingRule('quasar-alpha', directory));
  expect((await Effect.runPromise(loadPricing(directory))).info.rules.map((rule) => rule.model)).toEqual([
    'another-model',
  ]);
});

test('invalid custom rates fail schema validation and dependent aliases prevent unsafe deletion', async () => {
  expect(() =>
    Schema.decodeUnknownSync(PricingRule)({
      model: 'model',
      kind: 'rates',
      rates: { inputPerMillion: -1, outputPerMillion: 2 },
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(PricingRule)({
      model: 'model',
      kind: 'rates',
      rates: { inputPerMillion: Infinity, outputPerMillion: 2 },
    }),
  ).toThrow();
  const directory = await temporary();
  await Effect.runPromise(
    setPricingRule(
      { model: 'custom', kind: 'rates', nickname: 'Custom', rates: { inputPerMillion: 1, outputPerMillion: 2 } },
      directory,
    ),
  );
  await Effect.runPromise(setPricingRule({ model: 'proxy', kind: 'alias', target: 'custom' }, directory));
  expect((await Effect.runPromiseExit(deletePricingRule('custom', directory)))._tag).toBe('Failure');
  expect((await Effect.runPromise(loadPricing(directory))).info.rules).toHaveLength(2);
});

test('a synced policy installs exact central rates and rules while invalid revisions preserve the local cache', async () => {
  const central = await temporary();
  const local = await temporary();
  const centralState = await Effect.runPromise(
    setPricingRule({ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }, central),
  );
  await Effect.runPromise(setPricingRule({ model: 'local-only-model', kind: 'free' }, local));
  const installed = await Effect.runPromise(installPricingPolicy(centralState.policy, local));
  const loaded = await Effect.runPromise(loadPricing(local));
  expect(installed.policy).toEqual(centralState.policy);
  expect(loaded.policy).toEqual(centralState.policy);
  expect(repriceEvent(event(), loaded.policy)).toEqual(repriceEvent(event(), centralState.policy));
  expect(loaded.info.checkedAt).not.toBeNull();
  const tampered = { ...centralState.policy, rules: [{ model: 'quasar-alpha', kind: 'free' as const }] };
  expect((await Effect.runPromiseExit(installPricingPolicy(tampered, local)))._tag).toBe('Failure');
  expect((await Effect.runPromise(loadPricing(local))).policy).toEqual(centralState.policy);
  const cycle = { ...centralState.policy, rules: [{ model: 'loop', kind: 'alias' as const, target: 'loop' }] };
  expect((await Effect.runPromiseExit(installPricingPolicy(cycle, local)))._tag).toBe('Failure');
  const advanced = await Effect.runPromise(setPricingRule({ model: 'fresh-edit', kind: 'free' }, local));
  expect(
    (await Effect.runPromiseExit(installPricingPolicy(centralState.policy, local, loaded.policy.revision)))._tag,
  ).toBe('Failure');
  expect((await Effect.runPromise(loadPricing(local))).policy).toEqual(advanced.policy);
  expect(
    (await Effect.runPromise(installPricingPolicy(advanced.policy, local, loaded.policy.revision))).policy,
  ).toEqual(advanced.policy);
});

const upstream = () =>
  Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [
      `upstream-${index}`,
      {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        input_cost_per_token_priority: 0.000003,
        cache_creation_input_token_cost_above_1hr: 0.000004,
      },
    ]),
  );

test('upstream validation keeps full tier/TTL rates and refuses incomplete or malformed downloads', async () => {
  const valid = await Effect.runPromise(decodeUpstreamPrices(upstream(), new Date('2026-10-03T12:00:00Z')));
  expect(valid.models['upstream-0']?.input_cost_per_token_priority).toBe(0.000003);
  expect(valid.models['upstream-0']?.cache_creation_input_token_cost_above_1hr).toBe(0.000004);
  expect(valid.updatedAt).toBe('2026-10-03T12:00:00.000Z');
  expect(
    (await Effect.runPromiseExit(decodeUpstreamPrices({ one: { input_cost_per_token: 1, output_cost_per_token: 2 } })))
      ._tag,
  ).toBe('Failure');
  expect(
    (
      await Effect.runPromiseExit(
        decodeUpstreamPrices({ ...upstream(), bad: { input_cost_per_token: -1, output_cost_per_token: 2 } }),
      )
    )._tag,
  ).toBe('Failure');
});

test('refresh requests share one flight, preserve concurrent rules, and keep last valid catalog on failure', async () => {
  const directory = await temporary();
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  let invalid = false;
  const mockedFetch = Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (url !== PRICING_DOWNLOAD) return originalFetch(...args);
      downloads++;
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(Response.json(invalid ? {} : upstream())), 20);
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const refresh = () =>
    Effect.runPromise(refreshPricing(directory).pipe(Effect.provideService(FetchHttpClient.Fetch, mockedFetch)));
  {
    const first = refresh();
    const second = refresh();
    await Effect.runPromise(setPricingRule({ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }, directory));
    const [a, b] = await Promise.all([first, second]);
    expect(downloads).toBe(1);
    expect(a.policy.revision).toBe(b.policy.revision);
    expect(a.info.rules.some((rule) => rule.model === 'quasar-alpha')).toBe(true);
    expect(a.policy.catalog.models['upstream-0']).toBeDefined();
    expect(a.policy.catalog.models['gpt-6.1-sol']).toBeDefined();
    expect(a.info.refreshError).toBeNull();
    expect(pricingRefreshDue(a.info)).toBe(false);
    expect(pricingRefreshDue(a.info, new Date(Date.parse(a.info.checkedAt ?? '') + 86_400_000))).toBe(true);
    invalid = true;
    const fallback = await refresh();
    expect(fallback.policy.revision).toBe(a.policy.revision);
    expect(fallback.info.refreshError).toContain('previous catalog');
    expect((await Effect.runPromise(loadPricing(directory))).policy.revision).toBe(a.policy.revision);
    expect(JSON.parse(await readFile(join(directory, 'pricing-state.json'), 'utf8')).rules).toHaveLength(1);
  }
});
