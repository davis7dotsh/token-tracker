import type { PricingInfo, PricingRule } from '../shared/pricing';

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const subsequence = (needle: string, haystack: string) => {
  let index = 0;
  for (const character of haystack) if (character === needle[index]) index++;
  return index === needle.length;
};

// Loose catalog search for the alias picker: separator- and order-insensitive
// token matching with a subsequence fallback. Exact/prefix matches rank first,
// then clean slugs ahead of namespaced `provider/model` duplicates.
export const rankCatalogMatches = (
  models: readonly string[],
  query: string,
  limit = 60,
  include: (name: string) => boolean = () => true,
) => {
  const search = query.trim().toLowerCase();
  const plainSearch = plain(search);
  const tokens = search.split(/[^a-z0-9.]+/).filter(Boolean);
  const namespacedLast = !search.includes('/');
  const ranked: { name: string; rank: readonly [number, number, number, number] }[] = [];
  for (const name of models) {
    if (!include(name)) continue;
    const lower = name.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const plainName = plain(lower);
    const plainBase = plain(base);
    const matchClass = !search
      ? 3
      : lower === search || base === search || plainBase === plainSearch
        ? 0
        : base.startsWith(search) || plainBase.startsWith(plainSearch)
          ? 1
          : lower.startsWith(search)
            ? 2
            : base.includes(search) || plainBase.includes(plainSearch)
              ? 3
              : lower.includes(search) || plainName.includes(plainSearch)
                ? 4
                : tokens.length > 0 && tokens.every((token) => plainName.includes(plain(token)))
                  ? 5
                  : plainSearch.length >= 3 && subsequence(plainSearch, plainName)
                    ? 6
                    : -1;
    if (matchClass < 0) continue;
    const segments = name.split('/').length;
    ranked.push({
      name,
      rank: [matchClass, namespacedLast && segments > 1 ? 1 : 0, segments, base.length] as const,
    });
  }
  return ranked
    .sort((left, right) => {
      for (const [index, value] of left.rank.entries()) {
        if (value !== right.rank[index]) return value - right.rank[index];
      }
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })
    .slice(0, limit)
    .map((entry) => entry.name);
};

export const createAliasValidation = (info: Pick<PricingInfo, 'models' | 'rules'>) => {
  const rules = new Map(info.rules.map((rule) => [rule.model, rule]));
  // PricingInfo combines catalog and saved-rule names. Namespace/date
  // fallbacks can overlap rules, so the server validates their catalog price.
  const catalog = new Set(info.models);
  const hasCatalogPrice = (name: string) => {
    if (catalog.has(name)) return true;
    for (const prefix of ['openai/', 'anthropic/', 'xai/', 'meta/']) {
      if (catalog.has(prefix + name)) return true;
      if (name.startsWith(prefix) && catalog.has(name.slice(prefix.length))) return true;
    }
    return name.startsWith('claude-') && /-\d{8}$/.test(name) && catalog.has(name.slice(0, -9));
  };

  return (model: string, target: string) => {
    const source = model.trim();
    let current = target.trim();
    if (!current) return 'Choose a catalog model or a saved pricing rule.';
    if (current.length > 200) return 'Choose a model ID under 200 characters.';
    if (current === source) return 'Choose a different model. This model cannot alias itself.';
    const visited = new Set<string>();
    while (true) {
      if (current === source) return `That model already maps back to ${source}. Choose a different target.`;
      if (visited.has(current)) return 'That model has a circular alias. Choose a different target.';
      visited.add(current);
      const rule = rules.get(current);
      if (rule?.kind === 'alias') {
        current = rule.target;
        continue;
      }
      if (rule || hasCatalogPrice(current)) return undefined;
      return 'Choose a catalog model or a saved rule with known pricing.';
    }
  };
};

type Rate = number | null | undefined;
export type PricingDraft = {
  model: string;
  kind: PricingRule['kind'];
  target: string;
  nickname: string;
  rates: { input: Rate; output: Rate; cacheRead: Rate; cacheWrite: Rate; cacheWrite1h: Rate };
};
type AliasValidation = ReturnType<typeof createAliasValidation>;

const validRate = (value: Rate) => value == null || (Number.isFinite(value) && value >= 0);

// Why a draft cannot autosave yet, or undefined once it is a complete rule.
export const draftIssue = (draft: PricingDraft, validateAlias: AliasValidation) => {
  const model = draft.model.trim();
  if (!model) return 'Enter the model ID from your usage logs.';
  if (model.length > 200) return 'Enter a model ID under 200 characters.';
  if (draft.kind === 'alias') return validateAlias(model, draft.target);
  if (draft.kind === 'free') return undefined;
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = draft.rates;
  if (input == null || output == null) return 'Enter input and output rates.';
  if (![input, output, cacheRead, cacheWrite, cacheWrite1h].every(validRate)) return 'Rates must be zero or more.';
  if (draft.nickname.trim().length > 200) return 'Keep the display name under 200 characters.';
  return undefined;
};

export const ruleFromDraft = (draft: PricingDraft, validateAlias: AliasValidation): PricingRule | undefined => {
  if (draftIssue(draft, validateAlias)) return undefined;
  const model = draft.model.trim();
  if (draft.kind === 'alias') return { model, kind: 'alias', target: draft.target.trim() };
  if (draft.kind === 'free') return { model, kind: 'free' };
  const { input, output, cacheRead, cacheWrite, cacheWrite1h } = draft.rates;
  if (input == null || output == null) return undefined;
  const nickname = draft.nickname.trim();
  return {
    model,
    kind: 'rates',
    ...(nickname ? { nickname } : {}),
    rates: {
      inputPerMillion: input,
      outputPerMillion: output,
      ...(cacheRead == null ? {} : { cacheReadPerMillion: cacheRead }),
      ...(cacheWrite == null ? {} : { cacheWritePerMillion: cacheWrite }),
      ...(cacheWrite1h == null ? {} : { cacheWrite1hPerMillion: cacheWrite1h }),
    },
  };
};

export const draftFromRule = (model: string, rule: PricingRule | undefined): PricingDraft => ({
  model,
  kind: rule?.kind ?? 'alias',
  target: rule?.kind === 'alias' ? rule.target : '',
  nickname: rule?.kind === 'rates' ? (rule.nickname ?? '') : '',
  rates: {
    input: rule?.kind === 'rates' ? rule.rates.inputPerMillion : undefined,
    output: rule?.kind === 'rates' ? rule.rates.outputPerMillion : undefined,
    cacheRead: rule?.kind === 'rates' ? rule.rates.cacheReadPerMillion : undefined,
    cacheWrite: rule?.kind === 'rates' ? rule.rates.cacheWritePerMillion : undefined,
    cacheWrite1h: rule?.kind === 'rates' ? rule.rates.cacheWrite1hPerMillion : undefined,
  },
});

export const sameRule = (left: PricingRule | undefined, right: PricingRule | undefined) => {
  if (!left || !right || left.model !== right.model || left.kind !== right.kind) return left === right;
  if (left.kind === 'alias') return right.kind === 'alias' && left.target === right.target;
  if (left.kind === 'free') return true;
  if (right.kind !== 'rates' || left.nickname !== right.nickname) return false;
  const keys = [
    'inputPerMillion',
    'outputPerMillion',
    'cacheReadPerMillion',
    'cacheWritePerMillion',
    'cacheWrite1hPerMillion',
  ] as const;
  return keys.every((key) => left.rates[key] === right.rates[key]);
};
