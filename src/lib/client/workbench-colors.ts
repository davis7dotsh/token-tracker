import { provider } from '../shared/provider';
import type { Group } from './usage-workbench';

const lightDark = (light: string, dark: string) => `light-dark(${light}, ${dark})`;
const neutralInk = 'var(--wb-muted)';

// Light and dark inks share a hue. Start far apart so the largest slices are easy to tell apart.
const inks = [
  ['#0072ce', '#409fff'], // azure
  ['#c35a00', '#ff952e'], // orange
  ['#00835a', '#17cf88'], // emerald
  ['#7635ce', '#ac82ff'], // violet
  ['#a58200', '#ffd640'], // gold
  ['#c22079', '#ff63ae'], // pink
  ['#00889b', '#33d8ed'], // cyan
  ['#5b8510', '#b0e541'], // lime
  ['#c53129', '#ff584c'], // vermilion
  ['#384bc0', '#6977ff'], // indigo
  ['#90623e', '#d5a273'], // bronze
  ['#a325b2', '#e65ee6'], // orchid
  ['#2f636f', '#66a4ab'], // slate teal
  ['#a24162', '#ff9caa'], // rose
  ['#5f6375', '#b5bdce'], // silver
  ['#446837', '#88bd68'], // leaf
].map(([light, dark]) => lightDark(light, dark));

// Curated in-family ramps for core providers so multiple models from the same
// provider stay recognizable as a family while remaining distinct in charts.
// Primary stop [0] is the provider and matching harness color.
const providerRamps: Record<string, readonly string[]> = {
  anthropic: [
    ['#c45d3a', '#d97757'], // Claude terracotta orange
    ['#c27a14', '#e8a848'], // warm amber
    ['#963d20', '#f09e82'], // peach / rust
    ['#d66524', '#c75d38'], // burnt orange
    ['#a66e22', '#f2cb7a'], // warm ochre
  ].map(([light, dark]) => lightDark(light, dark)),
  openai: [
    ['#2b96d6', '#94d6ff'], // Codex super light blue
    ['#1e88a8', '#c4eaff'], // ice frost blue
    ['#1676b3', '#63b8f5'], // sky blue
    ['#1c949e', '#7de3f7'], // pale cyan blue
    ['#3c85ad', '#aedaf2'], // mist blue
  ].map(([light, dark]) => lightDark(light, dark)),
  meta: [
    ['#0852d6', '#2574f5'], // Meta royal blue
    ['#1e3cb5', '#526ef7'], // cobalt indigo
    ['#073996', '#2960d4'], // deep Meta blue
    ['#295fd1', '#618ef7'], // bright royal blue
    ['#2e339e', '#6f7cf5'], // periwinkle blue
  ].map(([light, dark]) => lightDark(light, dark)),
  google: [
    ['#3b8c42', '#58a65c'], // Antigravity green
    ['#25784c', '#82d486'], // mint leaf
    ['#568f24', '#9bc95f'], // sage green
    ['#286e33', '#3e9453'], // forest green
    ['#1b8266', '#56c79e'], // emerald green
  ].map(([light, dark]) => lightDark(light, dark)),
  xai: [
    ['#1f242b', '#ededed'], // Grok white on dark, charcoal on light
    ['#4b5360', '#c2c8d1'], // silver
    ['#6e7785', '#969eaa'], // steel
    ['#343b46', '#dadfe6'], // platinum
    ['#5b6472', '#adb4bf'], // pewter
  ].map(([light, dark]) => lightDark(light, dark)),
};

const categoryInks: Record<string, string> = {
  // Core providers & their matching harnesses
  anthropic: providerRamps.anthropic[0],
  claude: providerRamps.anthropic[0],
  openai: providerRamps.openai[0],
  codex: providerRamps.openai[0],
  meta: providerRamps.meta[0],
  muse: providerRamps.meta[0],
  google: providerRamps.google[0],
  antigravity: providerRamps.google[0],
  xai: providerRamps.xai[0],
  grok: providerRamps.xai[0],
  // Standalone harnesses
  pi: lightDark('#c93b82', '#f06ba8'),
  cursor: lightDark('#7042d4', '#a78bfa'),
  // Additional providers
  deepseek: lightDark('#4b55d6', '#7c86ff'),
  alibaba: lightDark('#7c3aed', '#b185ff'),
  mistral: lightDark('#a67c00', '#f2c94c'),
  moonshot: lightDark('#0b8394', '#3dd5e8'),
  zai: lightDark('#0f8072', '#38c9b4'),
  nvidia: lightDark('#5a8a0a', '#8bd435'),
  cohere: lightDark('#b8406b', '#eb739f'),
  amazon: lightDark('#b5620c', '#f09a38'),
  azure: lightDark('#0067b8', '#4f9ee3'),
  openrouter: lightDark('#9333c9', '#cc7af0'),
  together: lightDark('#c4362c', '#f26b63'),
  groq: lightDark('#cf4c20', '#f5764c'),
  perplexity: lightDark('#127d87', '#2fd4c5'),
  huggingface: lightDark('#9e7800', '#f5cd47'),
  fireworks: lightDark('#be2566', '#f472b6'),
};

const neutralNames = new Set(['unknown', 'other', '__other__', 'cursor/unknown']);

const extraShades = [
  (base: string) => `color-mix(in oklab, ${base} 74%, light-dark(black, white))`,
  (base: string) => `color-mix(in oklab, ${base} 72%, light-dark(white, #0b0e12))`,
  (base: string) => `color-mix(in oklab, ${base} 56%, light-dark(black, white))`,
  (base: string) => `color-mix(in oklab, ${base} 56%, light-dark(white, #0b0e12))`,
] as const;

const modelProvider = (model: string) => provider(model.replace(/^cursor-grok-(?=\d)/i, 'grok-'));

export function categoryColor(name: string) {
  const key = name.trim().toLowerCase();
  if (neutralNames.has(key)) return neutralInk;
  return categoryInks[key];
}

function modelProviderInk(providerName: string, slot: number) {
  const ramp = providerRamps[providerName];
  if (ramp) {
    if (slot < ramp.length) return ramp[slot];
    const extra = slot - ramp.length;
    return extraShades[extra % extraShades.length](ramp[extra % ramp.length]);
  }
  const base = categoryInks[providerName];
  if (!base) return undefined;
  if (slot === 0) return base;
  return extraShades[(slot - 1) % extraShades.length](base);
}

function chartInk(index: number) {
  if (index < inks.length) return inks[index];
  // Spread the long tail around the hue wheel without fading it toward the background.
  const n = index - inks.length;
  const hue = (25 + n * 137.508) % 360;
  return `light-dark(oklch(${n % 2 ? '48%' : '59%'} 0.18 ${hue}), oklch(${n % 2 ? '82%' : '65%'} 0.18 ${hue}))`;
}

export function assignChartColors(
  group: Group,
  ranked: readonly { name: string }[],
  previous?: ReadonlyMap<string, string>,
) {
  const colors = new Map(previous);

  if (group === 'providers' || group === 'harnesses') {
    let fallbackIndex = [...colors.keys()].filter((name) => !categoryColor(name)).length;
    for (const { name } of ranked) {
      if (colors.has(name)) continue;
      colors.set(name, categoryColor(name) ?? chartInk(fallbackIndex++));
    }
    return colors;
  }

  if (group === 'models') {
    const usedByProvider = new Map<string, number>();
    let fallbackIndex = 0;
    for (const existing of colors.keys()) {
      if (neutralNames.has(existing.trim().toLowerCase())) continue;
      const p = modelProvider(existing);
      if (categoryInks[p]) usedByProvider.set(p, (usedByProvider.get(p) ?? 0) + 1);
      else fallbackIndex++;
    }
    for (const { name } of ranked) {
      if (colors.has(name)) continue;
      if (neutralNames.has(name.trim().toLowerCase())) {
        colors.set(name, neutralInk);
        continue;
      }
      const p = modelProvider(name);
      if (categoryInks[p]) {
        const slot = usedByProvider.get(p) ?? 0;
        usedByProvider.set(p, slot + 1);
        colors.set(name, modelProviderInk(p, slot) ?? chartInk(fallbackIndex++));
      } else {
        colors.set(name, chartInk(fallbackIndex++));
      }
    }
    return colors;
  }

  // The RPC breakdown is token-ranked. Reserve the strongest inks for actual usage, not inactive filter options.
  for (const { name } of ranked) if (!colors.has(name)) colors.set(name, chartInk(colors.size));
  return colors;
}
