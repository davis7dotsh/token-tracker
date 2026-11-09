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
].map(([light, dark]) => `light-dark(${light}, ${dark})`);

function chartInk(index: number) {
  if (index < inks.length) return inks[index];
  // Spread the long tail around the hue wheel without fading it toward the background.
  const n = index - inks.length;
  const hue = (25 + n * 137.508) % 360;
  return `light-dark(oklch(${n % 2 ? '48%' : '59%'} 0.18 ${hue}), oklch(${n % 2 ? '82%' : '65%'} 0.18 ${hue}))`;
}

export function assignChartColors(ranked: readonly { name: string }[], previous?: ReadonlyMap<string, string>) {
  const colors = new Map(previous);
  // The RPC breakdown is token-ranked. Reserve the strongest inks for actual usage, not inactive filter options.
  for (const { name } of ranked) if (!colors.has(name)) colors.set(name, chartInk(colors.size));
  return colors;
}
