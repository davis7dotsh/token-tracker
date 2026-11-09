// Deterministic fictional sessions. Neither study reads from the tracker or its collectors.
globalThis.usageStudyFixture = (() => {
  const options = {
    device: ['Workstation', 'MacBook Pro', 'Build server', 'Studio Mini'],
    model: ['Sonnet 4.5', 'GPT-4.1', 'Opus 4.1', 'Gemini Flash', 'Unreported'],
    project: ['token-tracker', 'media-kit', 'render-lab', 'atlas-web', 'dotfiles', 'sdk-lab'],
    provider: ['Anthropic', 'OpenAI', 'Google', 'Unreported'],
    harness: ['Claude Code', 'Codex CLI', 'Cursor', 'Gemini CLI'],
  };
  const modelProviders = [0, 1, 0, 2, 3];
  const rates = [1.48, 1.02, 3.8, 0.5, 0]; // Sample blended rates per million tokens, not a price sheet.
  const start = Date.UTC(2026, 4, 13);
  const dayMs = 86400000;
  let seed = 317;
  const roll = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296;
  const pick = (weights) => {
    let n = roll() * weights.reduce((a, b) => a + b, 0);
    return weights.findIndex((v) => (n -= v) < 0);
  };
  const runs = [];
  for (let day = 0; day < 180; day++) {
    const growth = day < 150 ? 0.7 + 0.35 * Math.sin(day / 9) : 0.82 + 0.38 * Math.sin(day * 0.39);
    const burst =
      new Map([
        [156, 2.2],
        [165, 1.55],
        [170, 2.15],
        [172, 3.2],
        [176, 1.6],
        [178, 1.18],
      ]).get(day) ?? 0;
    const amp = (growth + burst) * (0.56 + roll() * 0.85);
    const count = Math.round(46 + amp * 72);
    for (let i = 0; i < count; i++) {
      const device = pick([
        3.8 + burst * 3 + Math.sin(day / 4) * 2.4,
        2.8 + Math.cos(day / 3) * 1.6,
        1.6 + (day % 6 === 0 ? 5 : 0),
        1.15,
      ]);
      const project = pick([device === 0 ? 5 : 2.3, device === 2 ? 4.5 : 1.9, device === 1 ? 3.5 : 1.4, 1.7, 0.8, 0.5]);
      const model = pick([4 + Math.sin(day / 2) * 2.7, device === 0 ? 5 : 2, 1.9 + burst, 1.1, 0.15]);
      const tokens = Math.round((0.13 + roll() ** 2 * 4.1) * 3600000 * (0.45 + amp * 0.65));
      const input = Math.round(tokens * (0.95 + roll() * 0.048));
      const cached = Math.round(input * (0.915 + roll() * 0.08));
      const minute = Math.floor(roll() * 1440);
      runs.push({
        id: runs.length + 1,
        day,
        minute,
        device: options.device[device],
        model: options.model[model],
        project: options.project[project],
        provider: options.provider[modelProviders[model]],
        harness: options.harness[roll() < 0.24 || model === 4 ? 2 : [0, 1, 0, 3][model]],
        tokens,
        input,
        cached,
        cost: (tokens / 1e6) * rates[model],
        priced: model !== 4,
      });
    }
  }
  return { options, start, dayMs, runs: runs.sort((a, b) => b.day - a.day || b.minute - a.minute || b.id - a.id) };
})();
