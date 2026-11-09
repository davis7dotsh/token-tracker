import { provider } from '../shared/provider';

export type VisualGrouping = 'harnesses' | 'providers' | 'models' | 'devices' | 'projects';

export const categoryNames: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  grok: 'Grok Build',
  muse: 'Muse',
  cursor: 'Cursor',
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

// Display labels only; keep the reported model ID for grouping, filters and exports.
export function modelLabel(id: string) {
  if (id === 'cursor/unknown') return 'Unreported model';
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(low|medium|high|max))?$/.exec(id);
  if (claude) {
    const [, family, major, minor, effort] = claude;
    return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}${effort ? ` (${effort})` : ''}`;
  }
  return id.replace(/^cursor-grok-(?=\d)/, 'Grok ');
}

const categoryColors: Record<string, string> = {
  claude: 'var(--series-claude)',
  anthropic: 'var(--series-claude)',
  codex: 'var(--series-codex)',
  openai: 'var(--series-codex)',
  pi: 'var(--series-pi)',
  grok: 'var(--series-grok)',
  muse: 'var(--series-muse)',
  cursor: 'var(--ink)',
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
