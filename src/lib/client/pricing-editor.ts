import type { PricingInfo } from '../shared/pricing';

export const createAliasValidation = (info: Pick<PricingInfo, 'models' | 'rules'>) => {
  const rules = new Map(info.rules.map((rule) => [rule.model, rule]));
  // PricingInfo combines catalog and saved-rule names. Namespace/date
  // fallbacks can overlap rules, so the server validates their catalog price.
  const catalog = new Set(info.models);
  const hasCatalogPrice = (name: string) => {
    if (catalog.has(name)) return true;
    for (const prefix of ['openai/', 'anthropic/', 'xai/']) {
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
