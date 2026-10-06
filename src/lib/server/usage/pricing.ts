import { Option, Schema } from 'effect';
import type { UsageEvent } from '../../shared/domain';
import { PriceSnapshot, type PricingPolicy, type PricingRule } from '../../shared/pricing';
import bundledPrices from './pricing.json';

export { PriceSnapshot } from '../../shared/pricing';
const decoded = Schema.decodeUnknownOption(PriceSnapshot)(bundledPrices);
const emptyPrices: typeof PriceSnapshot.Type = { updatedAt: 'unavailable', source: '', models: {} };
export const prices = Option.getOrElse(decoded, () => emptyPrices);
export const bundledPolicy: PricingPolicy = { catalog: prices, rules: [], revision: `bundled:${prices.updatedAt}` };

const catalogPrice = (model: string, policy: PricingPolicy) => {
  const lookup = (name: string) =>
    Object.hasOwn(policy.catalog.models, name) ? policy.catalog.models[name] : undefined;
  const direct = lookup(model);
  if (direct) return direct;
  for (const prefix of ['openai/', 'anthropic/', 'xai/']) {
    const namespaced = lookup(prefix + model);
    if (namespaced) return namespaced;
    if (model.startsWith(prefix) && lookup(model.slice(prefix.length))) return lookup(model.slice(prefix.length));
  }
  if (model.startsWith('claude-') && /-\d{8}$/.test(model)) return lookup(model.slice(0, -9));
  return undefined;
};

const customPrice = (rule: Extract<PricingRule, { kind: 'rates' }>) => {
  const fields: Record<string, number> = {
    input_cost_per_token: rule.rates.inputPerMillion / 1_000_000,
    output_cost_per_token: rule.rates.outputPerMillion / 1_000_000,
  };
  for (const [source, target] of [
    ['cacheReadPerMillion', 'cache_read_input_token_cost'],
    ['cacheWritePerMillion', 'cache_creation_input_token_cost'],
    ['cacheWrite1hPerMillion', 'cache_creation_input_token_cost_above_1hr'],
  ] as const) {
    const rate = rule.rates[source];
    if (rate !== undefined) fields[target] = rate / 1_000_000;
  }
  return fields;
};

type ResolvedPrice =
  | { model: string; kind: 'free' }
  | { model: string; kind: 'custom' | 'rates'; rates: Readonly<Record<string, number>> };
const policyResolvers = new WeakMap<
  PricingPolicy,
  { rules: Map<string, PricingRule>; models: Map<string, ResolvedPrice | undefined> }
>();
const resolverFor = (policy: PricingPolicy) => {
  const cached = policyResolvers.get(policy);
  if (cached) return cached;
  const rules = new Map<string, PricingRule>();
  for (const rule of policy.rules) if (!rules.has(rule.model)) rules.set(rule.model, rule);
  const resolver = { rules, models: new Map<string, ResolvedPrice | undefined>() };
  policyResolvers.set(policy, resolver);
  return resolver;
};

// Policies are immutable snapshots. Resolve each raw model once per snapshot,
// including alias chains and unknown models, rather than once per token record.
const resolveRule = (model: string, policy: PricingPolicy) => {
  const resolver = resolverFor(policy);
  if (resolver.models.has(model)) return resolver.models.get(model);
  const visited = new Set<string>();
  let current = model;
  let resolved: ResolvedPrice | undefined;
  while (!visited.has(current)) {
    if (resolver.models.has(current)) {
      resolved = resolver.models.get(current);
      break;
    }
    visited.add(current);
    const rule = resolver.rules.get(current);
    if (rule?.kind === 'alias') {
      current = rule.target;
      continue;
    }
    if (rule?.kind === 'free') resolved = { model: current, kind: 'free' };
    else if (rule?.kind === 'rates')
      resolved = { model: rule.nickname ?? current, kind: 'custom', rates: customPrice(rule) };
    else {
      const rates = catalogPrice(current, policy);
      if (rates) resolved = { model: current, kind: 'rates', rates };
    }
    break;
  }
  // Keep malformed or unusually varied model names from retaining unbounded
  // memory in a long-running server. Existing resolved prices remain correct.
  if (resolver.models.size > 4096) resolver.models.clear();
  for (const name of visited) resolver.models.set(name, resolved);
  return resolved;
};

export const resolveDisplayModel = (rawModel: string, policy: PricingPolicy = bundledPolicy) =>
  resolveRule(rawModel, policy)?.model ?? rawModel;

export const validatePricingRules = (catalog: typeof PriceSnapshot.Type, rules: readonly PricingRule[]) => {
  if (new Set(rules.map((rule) => rule.model)).size !== rules.length)
    return 'Only one pricing rule can be saved for each model.';
  const policy = { catalog, rules, revision: '' };
  const byModel = resolverFor(policy).rules;
  const validated = new Set<string>();
  for (const rule of rules) {
    if (rule.kind !== 'alias') continue;
    const visited = new Set<string>();
    let current = rule.model;
    while (true) {
      if (validated.has(current)) break;
      if (visited.has(current)) return `The alias for ${rule.model} would create a cycle.`;
      visited.add(current);
      const next = byModel.get(current);
      if (next?.kind !== 'alias') break;
      current = next.target;
    }
    if (!resolveRule(rule.model, policy))
      return `The alias target for ${rule.model} has no known catalog or custom pricing.`;
    for (const model of visited) validated.add(model);
  }
  return null;
};

// Reasoning is already contained in output. Catalog estimates never borrow
// standard rates for a different service tier. Explicit custom rates override
// the catalog for every tier and context size; missing cache rates stay unknown.
const tiers: Readonly<Record<string, string>> = {
  '': '',
  default: '',
  standard: '',
  priority: '_priority',
  fast: '_priority',
  ultrafast: '_ultrafast',
  flex: '_flex',
  batch: '_batches',
  batches: '_batches',
};
const costFields = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
] as const;
const preparedRates = new WeakMap<Readonly<Record<string, number>>, Map<string, readonly (number | undefined)[]>>();
const ratesFor = (price: Readonly<Record<string, number>>, contextSuffix: string, tierSuffix: string) => {
  let variants = preparedRates.get(price);
  if (!variants) {
    variants = new Map();
    preparedRates.set(price, variants);
  }
  const suffix = contextSuffix + tierSuffix;
  const cached = variants.get(suffix);
  if (cached) return cached;
  const rates = costFields.map((field) => {
    const rate = price[field + suffix] ?? (contextSuffix ? price[field + tierSuffix] : undefined);
    return rate !== undefined && Number.isFinite(rate) && rate >= 0 ? rate : undefined;
  });
  variants.set(suffix, rates);
  return rates;
};
const ratesForEvent = (
  event: UsageEvent,
  tier: string,
  resolved: Extract<ResolvedPrice, { kind: 'custom' | 'rates' }>,
) => {
  const price = resolved.rates;
  const input = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
  let contextSuffix = '';
  if (input > 200_000 && price.input_cost_per_token_above_200k_tokens !== undefined)
    contextSuffix = '_above_200k_tokens';
  if (input > 272_000 && price.input_cost_per_token_above_272k_tokens !== undefined)
    contextSuffix = '_above_272k_tokens';
  const normalizedTier = tier.trim().toLowerCase();
  const tierSuffix =
    resolved.kind === 'custom' ? '' : Object.hasOwn(tiers, normalizedTier) ? tiers[normalizedTier] : undefined;
  return tierSuffix === undefined ? undefined : ratesFor(price, contextSuffix, tierSuffix);
};
const missingRates = (event: UsageEvent, write: number, write1h: number, rates: readonly (number | undefined)[]) =>
  (event.inputTokens > 0 && rates[0] === undefined) ||
  (event.outputTokens > 0 && rates[1] === undefined) ||
  (event.cacheReadTokens > 0 && rates[2] === undefined) ||
  (write > 0 && rates[3] === undefined) ||
  (write1h > 0 && rates[4] === undefined);
const hasPricingMetadata = (event: UsageEvent, resolved: ResolvedPrice | undefined) =>
  (resolved?.kind === 'custom' || event.serviceTier !== undefined) &&
  (event.cacheWriteTokens === 0 || event.cacheWrite1hTokens !== undefined);
const estimateResolvedCost = (
  event: UsageEvent,
  cacheWrite1h: number,
  tier: string,
  resolved: ResolvedPrice | undefined,
) => {
  if (!resolved) return { costUsd: 0, costKnown: false };
  if (resolved.kind === 'free') return { costUsd: 0, costKnown: true };
  const rates = ratesForEvent(event, tier, resolved);
  if (!rates) return { costUsd: 0, costKnown: false };
  const write1h = Math.min(Math.max(0, cacheWrite1h), event.cacheWriteTokens);
  const write = event.cacheWriteTokens - write1h;
  if (missingRates(event, write, write1h, rates)) return { costUsd: 0, costKnown: false };
  const costUsd =
    event.inputTokens * (rates[0] ?? 0) +
    event.outputTokens * (rates[1] ?? 0) +
    event.cacheReadTokens * (rates[2] ?? 0) +
    write * (rates[3] ?? 0) +
    write1h * (rates[4] ?? 0);
  return Number.isFinite(costUsd) ? { costUsd, costKnown: true } : { costUsd: 0, costKnown: false };
};
const retainedCost = (event: UsageEvent) => ({
  costUsd: event.costKnown ? event.costUsd : 0,
  costKnown: event.costKnown,
});
const usesReportedGrokCost = (event: UsageEvent, policy: PricingPolicy) =>
  event.harness === 'grok' && !resolverFor(policy).rules.has(event.rawModel ?? event.model);
const reportedGrokCost = (event: UsageEvent) => {
  const costUsd = event.reportedCostUsd;
  return costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0
    ? { costUsd, costKnown: true }
    : { costUsd: 0, costKnown: false };
};

const freeTokenCosts = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
// Attribution is available only when the same policy can explain the already
// priced total. Native ledger and retained legacy costs have no bucket prices.
export const tokenCostParts = (event: UsageEvent, policy: PricingPolicy = bundledPolicy) => {
  if (!event.costKnown || usesReportedGrokCost(event, policy)) return undefined;
  const resolved = resolveRule(event.rawModel ?? event.model, policy);
  if (resolved?.kind === 'free') return event.costUsd === 0 ? freeTokenCosts : undefined;
  if (!resolved || !hasPricingMetadata(event, resolved)) return undefined;
  const rates = ratesForEvent(event, event.serviceTier ?? '', resolved);
  if (!rates) return undefined;
  const write1h = Math.min(Math.max(0, event.cacheWrite1hTokens ?? 0), event.cacheWriteTokens);
  const write = event.cacheWriteTokens - write1h;
  if (missingRates(event, write, write1h, rates)) return undefined;
  const input = event.inputTokens * (rates[0] ?? 0);
  const output = event.outputTokens * (rates[1] ?? 0);
  const cacheRead = event.cacheReadTokens * (rates[2] ?? 0);
  const cacheWrite = write * (rates[3] ?? 0) + write1h * (rates[4] ?? 0);
  const sum = input + output + cacheRead + cacheWrite;
  // Permit arithmetic grouping roundoff, without scaling rates to a different
  // reported total or allocating that total according to token proportions.
  if (!Number.isFinite(sum) || Math.abs(sum - event.costUsd) > Number.EPSILON * Math.max(sum, event.costUsd) * 8)
    return undefined;
  return { input, output, cacheRead, cacheWrite };
};

export const estimateCost = (event: UsageEvent, cacheWrite1h = 0, tier = '', policy: PricingPolicy = bundledPolicy) => {
  // A Grok row aggregates several requests, so its summed input cannot identify
  // any request's context/tier price. Use complete provider costs by default;
  // saved rules explicitly override them, and resetting a rule restores them.
  if (usesReportedGrokCost(event, policy)) return reportedGrokCost(event);
  const resolved = resolveRule(event.rawModel ?? event.model, policy);
  return estimateResolvedCost(event, cacheWrite1h, tier, resolved);
};

export const repriceEvent = (event: UsageEvent, policy: PricingPolicy): UsageEvent => {
  const rawModel = event.rawModel ?? event.model;
  const resolved = resolveRule(rawModel, policy);
  const model = resolved?.model ?? rawModel;
  // Free pricing needs no tier or duration metadata. Custom rates need cache
  // duration when writes are present; catalog prices also need the tier.
  // Legacy records retain reported costs until this metadata is available.
  const cost = usesReportedGrokCost(event, policy)
    ? reportedGrokCost(event)
    : hasPricingMetadata(event, resolved) || resolved?.kind === 'free'
      ? estimateResolvedCost(event, event.cacheWrite1hTokens ?? 0, event.serviceTier ?? '', resolved)
      : retainedCost(event);
  // Unchanged immutable records can be shared across dashboard snapshots.
  if (
    event.rawModel === rawModel &&
    event.model === model &&
    event.costUsd === cost.costUsd &&
    event.costKnown === cost.costKnown
  )
    return event;
  return { ...event, rawModel, model, ...cost };
};
