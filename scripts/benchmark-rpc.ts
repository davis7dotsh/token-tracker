import { makeDashboardClient } from '../src/lib/client/dashboard-rpc';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
const ranges = ['today', '7d', '30d', '90d', '6m', 'all'] as const;
const range = ranges.find((value) => value === (process.argv[3] ?? '30d'));
const iterations = Number(process.argv[4] ?? 5);
const shape = process.argv[5] ?? 'full';
if (
  (shape !== 'full' && shape !== 'page') ||
  !range ||
  !Number.isInteger(iterations) ||
  iterations < 1 ||
  iterations > 50
) {
  console.error('Usage: bun run bench [base-url] [today|7d|30d|90d|6m|all] [repeat-count: 1–50] [full|page]');
  process.exit(1);
}
const client = makeDashboardClient(new URL('/rpc', base).href, { requestTimeoutMs: 180_000 });
const query = { range, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

const measure = async <A>(operation: string, run: () => Promise<A>) => {
  const started = performance.now();
  const result = await run();
  const milliseconds = Math.round((performance.now() - started) * 10) / 10;
  const serializedResultBytes = Buffer.byteLength(JSON.stringify(result));
  console.log(JSON.stringify({ operation, milliseconds, serializedResultBytes }));
  return { result, milliseconds };
};

try {
  const read = () => (shape === 'page' ? client.getUsagePage(query, 1) : client.getUsage(query));
  console.log(JSON.stringify({ range, timezone: query.timezone, iterations, shape }));
  await measure('devices', () => client.getDevices());
  const first = await measure('usage-first', read);
  const repeats = [];
  let unchanged = true;
  for (let index = 0; index < iterations; index++) {
    const next = await measure(`usage-repeat-${index + 1}`, read);
    repeats.push(next.milliseconds);
    unchanged &&= JSON.stringify(next.result.totals) === JSON.stringify(first.result.totals);
  }
  repeats.sort((left, right) => left - right);
  await measure('pricing', () => client.getPricing(query));
  console.log(
    JSON.stringify({
      operation: 'summary',
      firstMilliseconds: first.milliseconds,
      repeatMedianMilliseconds:
        (repeats[Math.floor((repeats.length - 1) / 2)]! + repeats[Math.floor(repeats.length / 2)]!) / 2,
      repeatP95Milliseconds: repeats[Math.ceil(repeats.length * 0.95) - 1],
      tokens: first.result.totals.tokens,
      sessions: first.result.totals.sessions,
      totalsUnchangedBetweenReads: unchanged,
    }),
  );
} finally {
  await client.dispose();
}
