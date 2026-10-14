import type { PricingInfo } from '../shared/pricing';

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
