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

const resolveRule = (model: string, policy: PricingPolicy) => {
  const visited = new Set<string>();
  let current = model;
  while (!visited.has(current)) {
    visited.add(current);
    const rule = policy.rules.find((rule) => rule.model === current);
    if (rule?.kind === 'alias') {
      current = rule.target;
      continue;
    }
    if (rule?.kind === 'free') return { model: current, kind: 'free' as const };
    if (rule?.kind === 'rates')
      return { model: rule.nickname ?? current, kind: 'custom' as const, rates: customPrice(rule) };
    const rates = catalogPrice(current, policy);
    return rates ? { model: current, kind: 'rates' as const, rates } : undefined;
  }
  return undefined;
};

export const resolveDisplayModel = (rawModel: string, policy: PricingPolicy = bundledPolicy) =>
  resolveRule(rawModel, policy)?.model ?? rawModel;

export const validatePricingRules = (catalog: typeof PriceSnapshot.Type, rules: readonly PricingRule[]) => {
  if (new Set(rules.map((rule) => rule.model)).size !== rules.length)
    return 'Only one pricing rule can be saved for each model.';
  const policy = { catalog, rules, revision: '' };
  for (const rule of rules) {
    if (rule.kind !== 'alias') continue;
    const visited = new Set<string>();
    let current = rule.model;
    while (true) {
      if (visited.has(current)) return `The alias for ${rule.model} would create a cycle.`;
      visited.add(current);
      const next = rules.find((item) => item.model === current);
      if (next?.kind !== 'alias') break;
      current = next.target;
    }
    if (!resolveRule(rule.model, policy))
      return `The alias target for ${rule.model} has no known catalog or custom pricing.`;
  }
  return null;
};

// Reasoning is already contained in output. Catalog estimates never borrow
// standard rates for a different service tier. Explicit custom rates override
// the catalog for every tier and context size; missing cache rates stay unknown.
export const estimateCost = (event: UsageEvent, cacheWrite1h = 0, tier = '', policy: PricingPolicy = bundledPolicy) => {
  const resolved = resolveRule(event.rawModel ?? event.model, policy);
  if (!resolved) return { costUsd: 0, costKnown: false };
  if (resolved.kind === 'free') return { costUsd: 0, costKnown: true };
  const price = resolved.rates;
  const input = event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens;
  let contextSuffix = '';
  for (const [threshold, suffix] of [
    [200_000, '_above_200k_tokens'],
    [272_000, '_above_272k_tokens'],
  ] as const) {
    if (input > threshold && price['input_cost_per_token' + suffix] !== undefined) contextSuffix = suffix;
  }
  const tiers: Record<string, string> = {
    '': '',
    default: '',
    standard: '',
    priority: '_priority',
    fast: '_priority',
    flex: '_flex',
    batch: '_batches',
    batches: '_batches',
  };
  const tierSuffix = resolved.kind === 'custom' ? '' : tiers[tier.trim().toLowerCase()];
  if (tierSuffix === undefined) return { costUsd: 0, costKnown: false };
  const write1h = Math.min(Math.max(0, cacheWrite1h), event.cacheWriteTokens);
  let costUsd = 0;
  for (const [tokens, field] of [
    [event.inputTokens, 'input_cost_per_token'],
    [event.outputTokens, 'output_cost_per_token'],
    [event.cacheReadTokens, 'cache_read_input_token_cost'],
    [event.cacheWriteTokens - write1h, 'cache_creation_input_token_cost'],
    [write1h, 'cache_creation_input_token_cost_above_1hr'],
  ] as const) {
    if (!tokens) continue;
    const rate = price[field + contextSuffix + tierSuffix] ?? (contextSuffix ? price[field + tierSuffix] : undefined);
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) return { costUsd: 0, costKnown: false };
    costUsd += tokens * rate;
  }
  return Number.isFinite(costUsd) ? { costUsd, costKnown: true } : { costUsd: 0, costKnown: false };
};

export const repriceEvent = (event: UsageEvent, policy: PricingPolicy): UsageEvent => {
  const rawModel = event.rawModel ?? event.model;
  const model = resolveDisplayModel(rawModel, policy);
  const resolved = resolveRule(rawModel, policy);
  const hasMetadata =
    (resolved?.kind === 'custom' || event.serviceTier !== undefined) &&
    (event.cacheWriteTokens === 0 || event.cacheWrite1hTokens !== undefined);
  // Free pricing needs no tier or duration metadata. Custom rates need cache
  // duration when writes are present; catalog prices also need the tier.
  // Legacy records retain reported costs until this metadata is available.
  const cost =
    hasMetadata || resolved?.kind === 'free'
      ? estimateCost(event, event.cacheWrite1hTokens ?? 0, event.serviceTier ?? '', policy)
      : { costUsd: event.costKnown ? event.costUsd : 0, costKnown: event.costKnown };
  return { ...event, rawModel, model, ...cost };
};
