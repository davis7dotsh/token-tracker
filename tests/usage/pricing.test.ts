import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  tokenCostParts,
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

test('unchanged catalog, unknown, native ledger, and legacy prices preserve immutable record identity', () => {
  const catalog = event({ model: 'gpt-6.1-sol', rawModel: 'gpt-6.1-sol' });
  const { serviceTier: _tier, cacheWrite1hTokens: _duration, ...legacy } = catalog;
  const records = [
    { ...catalog, ...estimateCost(catalog) },
    event({ rawModel: 'quasar-alpha' }),
    event({
      harness: 'grok',
      model: 'grok-4.7-build-fast',
      rawModel: 'grok-4.7-build-fast',
      reportedCostUsd: 0.02673624,
      costUsd: 0.02673624,
      costKnown: true,
    }),
    { ...legacy, costUsd: 9, costKnown: true },
  ];
  for (const record of records) {
    const snapshot = Object.freeze(record);
    expect(repriceEvent(snapshot, bundledPolicy)).toBe(snapshot);
  }
});

test('pricing changes replace snapshots while preserving original usage and raw model identity', () => {
  const snapshot = Object.freeze(event({ rawModel: 'quasar-alpha' }));
  const free = repriceEvent(snapshot, policy([{ model: 'quasar-alpha', kind: 'free' }]));
  expect(free).not.toBe(snapshot);
  expect(free).toMatchObject({ costUsd: 0, costKnown: true });
  const rates = policy([
    {
      model: 'quasar-alpha',
      kind: 'rates',
      rates: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2 },
    },
  ]);
  const priced = repriceEvent(snapshot, rates);
  expect(priced).not.toBe(snapshot);
  expect(priced).toMatchObject({ model: 'quasar-alpha', rawModel: 'quasar-alpha', costKnown: true });
  expect(priced.costUsd).toBeCloseTo(0.032, 12);
  expect(repriceEvent(Object.freeze(priced), rates)).toBe(priced);

  const alias = policy([{ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }]);
  const renamed = repriceEvent(priced, alias);
  expect(renamed).not.toBe(priced);
  expect(renamed).toMatchObject({ model: 'gpt-6.1-sol', rawModel: 'quasar-alpha', costKnown: true });
  const unpriced = repriceEvent(renamed, bundledPolicy);
  expect(unpriced).not.toBe(renamed);
  expect(unpriced).toEqual(snapshot);
  expect(snapshot).toMatchObject({ model: 'quasar-alpha', rawModel: 'quasar-alpha', costKnown: false, costUsd: 0 });
  expect(priced.model).toBe('quasar-alpha');
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

test('complete Grok ledger costs survive collection and hub repricing for uncatalogued Build model IDs', () => {
  const recorded = event({
    harness: 'grok',
    model: 'grok-4.7-build-fast',
    inputTokens: 15_059,
    outputTokens: 104,
    cacheReadTokens: 17_152,
    reasoningTokens: 67,
    costKnown: true,
    costUsd: 267_362_400 / 10_000_000_000,
    reportedCostUsd: 267_362_400 / 10_000_000_000,
    requests: 2,
  });
  expect(estimateCost(recorded)).toEqual({ costKnown: true, costUsd: 0.02673624 });
  expect(repriceEvent(recorded, bundledPolicy)).toMatchObject({
    model: 'grok-4.7-build-fast',
    rawModel: 'grok-4.7-build-fast',
    costKnown: true,
    costUsd: 0.02673624,
    requests: 2,
  });
  expect(estimateCost({ ...recorded, costKnown: false, costUsd: 0 })).toEqual({
    costKnown: true,
    costUsd: 0.02673624,
  });
  expect(estimateCost({ ...recorded, reportedCostUsd: 0 })).toEqual({ costKnown: false, costUsd: 0 });
  expect(estimateCost({ ...recorded, harness: 'codex' })).toEqual({ costKnown: false, costUsd: 0 });

  const rules: PricingRule[] = [
    { model: recorded.model, kind: 'free' },
    {
      model: recorded.model,
      kind: 'rates',
      rates: { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5 },
    },
    { model: recorded.model, kind: 'alias', target: 'grok-4.6' },
  ];
  for (const rule of rules) {
    const pricing = policy([rule]);
    const expected = estimateCost(recorded, 0, '', pricing);
    expect(expected.costKnown).toBe(true);
    expect(expected.costUsd).not.toBe(recorded.costUsd);
    const repriced = repriceEvent(recorded, pricing);
    expect(repriced.costUsd).toBe(expected.costUsd);
    expect(repriced.reportedCostUsd).toBe(recorded.reportedCostUsd);
    expect(repriceEvent(repriced, bundledPolicy).costUsd).toBe(recorded.costUsd);
  }
});

test('Grok multi-call rows keep native costs and missing costs stay unpriced even for catalog models', () => {
  // Two 150k-input requests are each below the 200k tier. Applying the tier to
  // this aggregate would incorrectly double both input and output prices.
  const aggregate = event({
    harness: 'grok',
    model: 'grok-4.6',
    inputTokens: 300_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    reportedCostUsd: 0.612,
    requests: 2,
  });
  expect(estimateCost(aggregate)).toEqual({ costKnown: true, costUsd: 0.612 });
  expect(repriceEvent(aggregate, bundledPolicy)).toMatchObject({ costKnown: true, costUsd: 0.612 });
  expect(estimateCost({ ...aggregate, harness: 'pi' }).costUsd).toBeCloseTo(1.224, 12);
  const { reportedCostUsd: _reported, ...incomplete } = aggregate;
  expect(estimateCost(incomplete)).toEqual({ costKnown: false, costUsd: 0 });
  expect(repriceEvent({ ...incomplete, costUsd: 9, costKnown: true }, bundledPolicy)).toMatchObject({
    costKnown: false,
    costUsd: 0,
  });
  expect(estimateCost({ ...aggregate, reportedCostUsd: Infinity })).toEqual({ costKnown: false, costUsd: 0 });
  const custom = policy([
    { model: aggregate.model, kind: 'rates', rates: { inputPerMillion: 1, outputPerMillion: 2 } },
  ]);
  const repriced = repriceEvent(aggregate, custom);
  expect(repriced.costUsd).toBeCloseTo(0.304, 12);
  expect(repriceEvent(repriced, bundledPolicy).costUsd).toBe(0.612);
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

const ultrafastPolicy = {
  ...bundledPolicy,
  catalog: {
    ...bundledPolicy.catalog,
    models: {
      'gpt-6-astra': {
        input_cost_per_token: 1e-6,
        input_cost_per_token_above_272k_tokens: 2e-6,
        output_cost_per_token: 2e-6,
        cache_read_input_token_cost: 3e-6,
        cache_creation_input_token_cost: 4e-6,
        cache_creation_input_token_cost_above_1hr: 5e-6,
        input_cost_per_token_ultrafast: 10e-6,
        output_cost_per_token_ultrafast: 20e-6,
        cache_read_input_token_cost_ultrafast: 30e-6,
        cache_creation_input_token_cost_ultrafast: 40e-6,
        cache_creation_input_token_cost_above_1hr_ultrafast: 50e-6,
        input_cost_per_token_above_272k_tokens_ultrafast: 100e-6,
        output_cost_per_token_above_272k_tokens_ultrafast: 200e-6,
        cache_read_input_token_cost_above_272k_tokens_ultrafast: 300e-6,
        cache_creation_input_token_cost_above_272k_tokens_ultrafast: 400e-6,
        cache_creation_input_token_cost_above_1hr_above_272k_tokens_ultrafast: 500e-6,
      },
    },
  },
  rules: [{ model: 'vega-alpha', kind: 'alias', target: 'gpt-6-astra' }],
} satisfies PricingPolicy;
const ultrafastEvent = () =>
  event({
    model: 'gpt-6-astra',
    serviceTier: 'ultrafast',
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 400,
    cacheWrite1hTokens: 100,
  });

test('ultrafast uses its catalog rates for every token bucket and context size through aliases', () => {
  const request = ultrafastEvent();
  const priced = repriceEvent(request, ultrafastPolicy);
  expect(priced.costKnown).toBe(true);
  expect(priced.costUsd).toBeCloseTo(0.031, 12);
  const large = repriceEvent({ ...request, inputTokens: 300_000 }, ultrafastPolicy);
  expect(large.costKnown).toBe(true);
  expect(large.costUsd).toBeCloseTo(30.3, 12);
  const alias = repriceEvent({ ...request, model: 'vega-alpha' }, ultrafastPolicy);
  expect(alias).toMatchObject({ model: 'gpt-6-astra', rawModel: 'vega-alpha', costKnown: true });
  expect(alias.costUsd).toBe(priced.costUsd);
});

test('missing ultrafast cache rates remain unpriced despite available standard rates', () => {
  const { cache_read_input_token_cost_ultrafast: _missing, ...rates } = ultrafastPolicy.catalog.models['gpt-6-astra'];
  const pricing = {
    ...ultrafastPolicy,
    catalog: { ...ultrafastPolicy.catalog, models: { 'gpt-6-astra': rates } },
  };
  expect(repriceEvent(ultrafastEvent(), pricing)).toMatchObject({ costKnown: false, costUsd: 0 });
  expect(repriceEvent({ ...ultrafastEvent(), cacheReadTokens: 0 }, pricing).costKnown).toBe(true);
});

test('an unknown service tier remains unpriced instead of borrowing catalog rates', () => {
  expect(repriceEvent({ ...ultrafastEvent(), serviceTier: 'unknown-tier' }, ultrafastPolicy)).toMatchObject({
    costKnown: false,
    costUsd: 0,
  });
});

test('token cost parts share ultrafast context selection including large cache reads and aliases', () => {
  const fixtures = [
    { inputTokens: 100, cacheReadTokens: 300, expected: [0.001, 0.004, 0.009, 0.017] },
    { inputTokens: 300_000, cacheReadTokens: 300, expected: [30, 0.04, 0.09, 0.17] },
    { inputTokens: 100, cacheReadTokens: 300_000, expected: [0.01, 0.04, 90, 0.17] },
  ];
  for (const { expected, ...tokens } of fixtures) {
    const priced = repriceEvent({ ...ultrafastEvent(), model: 'vega-alpha', ...tokens }, ultrafastPolicy);
    const parts = tokenCostParts(priced, ultrafastPolicy);
    expect(parts).toBeDefined();
    if (!parts) throw new Error('Complete ultrafast rates must be attributable');
    [parts.input, parts.output, parts.cacheRead, parts.cacheWrite].forEach((cost, index) => {
      expect(cost).toBeCloseTo(expected[index], 12);
    });
    expect(Object.values(parts).reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(priced.costUsd, 12);
  }
});

test('custom token cost parts use USD per million and separate cache-write durations without counting reasoning twice', () => {
  const pricing = policy([
    {
      model: 'quasar-alpha',
      kind: 'rates',
      rates: {
        inputPerMillion: 2,
        outputPerMillion: 8,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 2.5,
        cacheWrite1hPerMillion: 4,
      },
    },
  ]);
  const request = event({
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheReadTokens: 3_000_000,
    cacheWriteTokens: 4_000_000,
    cacheWrite1hTokens: 1_000_000,
    reasoningTokens: 500_000,
    serviceTier: 'unknown-tier',
  });
  const priced = repriceEvent(request, pricing);
  const parts = tokenCostParts(priced, pricing);
  expect(parts).toMatchObject({ input: 2, output: 16, cacheWrite: 11.5 });
  expect(parts?.cacheRead).toBeCloseTo(0.6, 12);
  expect(priced.costUsd).toBeCloseTo(30.1, 12);
  expect(request).toMatchObject({ costKnown: false, costUsd: 0 });
});

test('free token parts need no tier or TTL metadata while retained and incomplete prices remain unavailable', () => {
  const { serviceTier: _tier, cacheWrite1hTokens: _ttl, ...legacy } = ultrafastEvent();
  const retained = repriceEvent({ ...legacy, costKnown: true, costUsd: 9 }, ultrafastPolicy);
  expect(retained.costUsd).toBe(9);
  expect(tokenCostParts(retained, ultrafastPolicy)).toBeUndefined();
  expect(tokenCostParts(ultrafastEvent(), ultrafastPolicy)).toBeUndefined();
  const free = policy([{ model: legacy.model, kind: 'free' }]);
  expect(tokenCostParts(repriceEvent(legacy, free), free)).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const { cache_read_input_token_cost_ultrafast: _rate, ...rates } = ultrafastPolicy.catalog.models['gpt-6-astra'];
  const incomplete = {
    ...ultrafastPolicy,
    catalog: { ...ultrafastPolicy.catalog, models: { 'gpt-6-astra': rates } },
  };
  expect(tokenCostParts({ ...ultrafastEvent(), costKnown: true }, incomplete)).toBeUndefined();
  expect(
    tokenCostParts({ ...ultrafastEvent(), serviceTier: 'unknown-tier', costKnown: true }, ultrafastPolicy),
  ).toBeUndefined();
});

test('native Grok totals stay unattributed while explicit rates can produce token parts', () => {
  const native = event({
    model: 'gpt-6-astra',
    harness: 'grok',
    serviceTier: '',
    reportedCostUsd: 12,
    requests: 3,
  });
  const priced = repriceEvent(native, bundledPolicy);
  expect(priced.costUsd).toBe(12);
  expect(tokenCostParts(priced, bundledPolicy)).toBeUndefined();
  const custom = policy([
    {
      model: native.model,
      kind: 'rates',
      rates: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2 },
    },
  ]);
  const explicit = repriceEvent(native, custom);
  const parts = tokenCostParts(explicit, custom);
  expect(parts).toBeDefined();
  if (!parts) throw new Error('Explicit Grok rates must be attributable');
  expect(Object.values(parts).reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(explicit.costUsd, 12);
  expect(explicit.reportedCostUsd).toBe(12);
});

test('token parts refuse inconsistent totals and different pricing snapshots instead of prorating', () => {
  const priced = repriceEvent(ultrafastEvent(), ultrafastPolicy);
  expect(tokenCostParts({ ...priced, costUsd: priced.costUsd + 1 }, ultrafastPolicy)).toBeUndefined();
  const changed = {
    ...ultrafastPolicy,
    catalog: {
      ...ultrafastPolicy.catalog,
      models: {
        'gpt-6-astra': { ...ultrafastPolicy.catalog.models['gpt-6-astra'], input_cost_per_token_ultrafast: 99e-6 },
      },
    },
  };
  expect(tokenCostParts(priced, changed)).toBeUndefined();
});

test('prepared alias chains stay independent across snapshots and preserve missing-rate and tier semantics', () => {
  const rules: PricingRule[] = Array.from({ length: 256 }, (_, index) => ({
    model: `proxy-${index}`,
    kind: 'alias',
    target: index === 255 ? 'quasar-alpha' : `proxy-${index + 1}`,
  }));
  const custom = {
    model: 'quasar-alpha',
    kind: 'rates' as const,
    nickname: 'Custom model',
    rates: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2 },
  };
  const priced = policy([...rules, custom]);
  expect(validatePricingRules(priced.catalog, priced.rules)).toBeNull();
  const request = event({ model: 'proxy-0', serviceTier: 'unknown-tier' });
  for (let index = 0; index < 2; index++) {
    expect(repriceEvent(request, priced)).toMatchObject({ model: 'Custom model', costKnown: true });
    expect(repriceEvent({ ...request, cacheWriteTokens: 10 }, priced).costKnown).toBe(false);
  }
  const free = policy([...rules, { model: 'quasar-alpha', kind: 'free' }]);
  expect(repriceEvent(request, free)).toMatchObject({ model: 'quasar-alpha', costUsd: 0, costKnown: true });
  expect(repriceEvent(request, policy(rules))).toMatchObject({ model: 'proxy-0', costKnown: false });
  const catalog = policy([{ model: 'proxy-0', kind: 'alias', target: 'gpt-6.1-sol' }]);
  expect(estimateCost(request, 0, 'constructor', catalog).costKnown).toBe(false);
  expect(estimateCost(event({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), 0, 'constructor').costKnown).toBe(
    false,
  );
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

test('cached pricing snapshots detect external edits, atomic replacement, deletion and corruption', async () => {
  const directory = await temporary();
  const filename = join(directory, 'pricing-state.json');
  const original = await Effect.runPromise(setPricingRule({ model: 'model-a', kind: 'free' }, directory));
  expect(await Effect.runPromise(loadPricing(directory))).toBe(original);
  const initialBytes = await readFile(filename, 'utf8');
  const editedBytes = initialBytes.replace('"model-a"', '"model-b"');
  expect(editedBytes.length).toBe(initialBytes.length);
  await writeFile(filename, editedBytes);
  const edited = await Effect.runPromise(loadPricing(directory));
  expect(edited.info.rules).toEqual([{ model: 'model-b', kind: 'free' }]);
  expect(edited.policy.revision).not.toBe(original.policy.revision);
  expect(await Effect.runPromise(loadPricing(directory))).toBe(edited);

  const replacement = join(directory, 'external-replacement.json');
  await writeFile(replacement, initialBytes);
  await rename(replacement, filename);
  const restored = await Effect.runPromise(loadPricing(directory));
  expect(restored.policy.revision).toBe(original.policy.revision);
  expect(restored.info.rules).toEqual(original.info.rules);

  await rm(filename);
  const absent = await Effect.runPromise(loadPricing(directory));
  expect(absent.info.rules).toEqual([]);
  expect(absent.info.refreshError).toBeNull();
  expect(await Effect.runPromise(loadPricing(directory))).toBe(absent);
  await writeFile(filename, '{invalid-json');
  const invalid = await Effect.runPromise(loadPricing(directory));
  expect(invalid.info.rules).toEqual([]);
  expect(invalid.info.refreshError).toContain('could not be read');
  await writeFile(filename, editedBytes);
  expect((await Effect.runPromise(loadPricing(directory))).info.rules).toEqual(edited.info.rules);
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
