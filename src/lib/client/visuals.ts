import { provider } from '../shared/provider';

export type VisualGrouping = 'harnesses' | 'providers' | 'models' | 'devices' | 'projects';

export const categoryNames: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok Build',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'Grok / xAI',
  deepseek: 'DeepSeek',
  alibaba: 'Qwen / Alibaba',
  mistral: 'Mistral',
  meta: 'Meta',
  moonshot: 'Moonshot',
  zai: 'Z.ai',
  cohere: 'Cohere',
  amazon: 'Amazon',
  azure: 'Azure',
  openrouter: 'OpenRouter',
  together: 'Together',
  groq: 'Groq',
  perplexity: 'Perplexity',
  nvidia: 'NVIDIA',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks',
  unknown: 'Unknown',
  other: 'Other',
  __other__: 'Other',
};

const categoryColors: Record<string, string> = {
  claude: 'var(--series-claude)',
  anthropic: 'var(--series-claude)',
  codex: 'var(--series-codex)',
  openai: 'var(--series-codex)',
  pi: 'var(--series-pi)',
  grok: 'var(--series-grok)',
  xai: 'var(--series-grok)',
  google: 'var(--series-gold)',
  deepseek: 'var(--series-indigo)',
  alibaba: 'var(--series-violet)',
  mistral: 'var(--series-coral)',
  meta: 'var(--series-indigo)',
  moonshot: 'var(--series-violet)',
  zai: 'var(--series-teal)',
  cohere: 'var(--series-teal)',
  amazon: 'var(--series-gold)',
  azure: 'var(--series-codex)',
  openrouter: 'var(--series-violet)',
  together: 'var(--series-coral)',
  groq: 'var(--series-coral)',
  perplexity: 'var(--series-teal)',
  nvidia: 'var(--series-grok)',
  huggingface: 'var(--series-gold)',
  fireworks: 'var(--series-pi)',
  unknown: 'var(--series-neutral)',
};

const distinctColors = [
  'var(--series-codex)',
  'var(--series-teal)',
  'var(--series-pi)',
  'var(--series-indigo)',
  'var(--series-gold)',
  'var(--series-violet)',
  'var(--series-grok)',
  'var(--series-rose)',
  'var(--series-red)',
  'var(--series-lime)',
  'var(--series-claude)',
  'var(--series-cyan)',
];
const stableHash = (name: string) => {
  let hash = 2166136261;
  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
};

export const distinctSeriesColors = (names: readonly string[]) => {
  const colors = new Map<string, string>();
  const used = new Set<string>();
  for (const [index, name] of [...new Set(names)].sort().entries()) {
    if (index % distinctColors.length === 0) used.clear();
    const preferred = stableHash(name) % distinctColors.length;
    const base =
      Array.from(
        { length: distinctColors.length },
        (_, offset) => distinctColors[(preferred + offset) % distinctColors.length],
      ).find((color) => !used.has(color)) ?? distinctColors[preferred];
    const cycle = Math.floor(index / distinctColors.length);
    colors.set(name, cycle ? `color-mix(in oklab, ${base} ${100 / (1 + cycle * 0.25)}%, var(--series-shade))` : base);
    used.add(base);
  }
  return colors;
};

export const seriesColor = (name: string, grouping: VisualGrouping) => {
  if (['other', '__other__'].includes(name.toLowerCase())) return 'var(--series-neutral)';
  if (grouping === 'models') {
    const base = categoryColors[provider(name)] ?? 'var(--series-neutral)';
    const shade = (stableHash(name) % 7) * 7;
    return shade ? `color-mix(in oklab, ${base} ${100 - shade}%, var(--series-shade))` : base;
  }
  if (grouping === 'harnesses' || grouping === 'providers')
    return categoryColors[name.toLowerCase()] ?? 'var(--series-neutral)';
  return distinctColors[stableHash(name) % distinctColors.length];
};
