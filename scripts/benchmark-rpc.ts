import { makeDashboardClient } from '../src/lib/client/rpc';

const base = process.argv[2] ?? 'http://enceladus.otter-hawksbill.ts.net:8787';
const client = makeDashboardClient(new URL('/rpc', base).href, { requestTimeoutMs: 60_000 });
const query = { range: '30d' as const, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

const measure = async <A>(operation: string, run: () => Promise<A>) => {
  const started = performance.now();
  const result = await run();
  console.log(
    JSON.stringify({
      operation,
      milliseconds: Math.round((performance.now() - started) * 10) / 10,
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
    }),
  );
  return result;
};

try {
  await measure('devices', () => client.getDevices());
  const first = await measure('usage-first', () => client.getUsage(query));
  const second = await measure('usage-repeat', () => client.getUsage(query));
  await measure('pricing', () => client.getPricing(query));
  console.log(
    JSON.stringify({
      tokens: second.totals.tokens,
      sessions: second.totals.sessions,
      tokensUnchangedBetweenReads: first.totals.tokens === second.totals.tokens,
    }),
  );
} finally {
  await client.dispose();
}
