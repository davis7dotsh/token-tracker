import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient } from '../../src/lib/client/dashboard-rpc';
import { LocalUsage, makeRpcWebHandler } from '../../src/lib/server/rpc/server';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';

const unavailable = 'Could not load usage. Try again.';
const success = (requestId: string, value: unknown = []) => ({
  _tag: 'Exit',
  requestId,
  exit: { _tag: 'Success', value },
});
const dashboard = buildDashboard(
  {
    events: [
      {
        id: 'event',
        timestamp: '2026-10-15T10:00:00Z',
        harness: 'codex',
        model: 'gpt-6.1-sol',
        project: '/work/app',
        repository: null,
        sessionId: 'session',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.01,
        costKnown: true,
      },
    ],
    sources: [{ harness: 'codex', path: '/work/app', files: 1, events: 1, status: 'ready' }],
    warnings: [],
    pricingUpdatedAt: '2026-10-15T00:00:00Z',
  },
  { range: 'today', timezone: 'UTC' },
  new Date('2026-10-15T12:00:00Z'),
);

test.each([
  ['HTML response', () => '<html>Sign in</html>'],
  ['truncated JSON', () => '{"_tag":"Exit","requestId":'],
  ['mismatched request ID', (id: string) => JSON.stringify(success(id + '-other'))],
  ['malformed exit', (requestId: string) => JSON.stringify({ _tag: 'Exit', requestId, exit: null })],
  ['server defect', () => JSON.stringify({ _tag: 'Defect', defect: 'Internal server details' })],
])('browser RPC rejects %s with a friendly error', async (_name, responseBody) => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message: { id: string } = JSON.parse(await request.text());
      return new Response(responseBody(message.id));
    },
  });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const [outcome] = await Promise.allSettled([client.getDevices()]);
    expect(outcome).toMatchObject({ status: 'rejected', reason: { message: unavailable } });
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});

test.each([
  ['null result', null],
  ['array result', []],
  ['empty result', {}],
  ['missing filters', { ...dashboard, filters: undefined }],
  ['null filters', { ...dashboard, filters: null }],
  ['non-array filter options', { ...dashboard, filters: { ...dashboard.filters, models: 'gpt-6.1-sol' } }],
  ['invalid optional selection', { ...dashboard, filters: { ...dashboard.filters, selectedModels: [42] } }],
  ['missing totals field', { ...dashboard, totals: { ...dashboard.totals, tokens: undefined } }],
  ['invalid previous totals', { ...dashboard, previous: {} }],
  ['invalid period', { ...dashboard, period: { start: 42, end: '2026-10-15' } }],
  ['invalid range', { ...dashboard, range: 'future' }],
  ['invalid session entry', { ...dashboard, sessions: [null] }],
  ['invalid session timestamp', { ...dashboard, sessions: [{ ...dashboard.sessions[0], lastActiveAt: 42 }] }],
  ['invalid breakdown name', { ...dashboard, models: [{ ...dashboard.models[0], name: 42 }] }],
  ['invalid daily bucket', { ...dashboard, daily: [null] }],
  ['invalid hourly series', { ...dashboard, hourly: [{ ...dashboard.hourly[0], harnesses: {} }] }],
  ['invalid optional chart series', { ...dashboard, daily: [{ ...dashboard.daily[0], providers: [null] }] }],
  ['invalid project chart series', { ...dashboard, daily: [{ ...dashboard.daily[0], projects: [null] }] }],
  ['invalid project insight', { ...dashboard, projectInsights: [null] }],
  [
    'invalid project insight paths',
    { ...dashboard, projectInsights: [{ ...dashboard.projectInsights?.[0], paths: [42] }] },
  ],
  ['null optional token costs', { ...dashboard, tokenCosts: null }],
  [
    'invalid token cost count',
    { ...dashboard, tokenCosts: { ...dashboard.tokenCosts, input: { costUSD: 0, unavailableTokens: -1 } } },
  ],
  ['invalid source', { ...dashboard, sources: [{ ...dashboard.sources[0], status: 'future' }] }],
  ['invalid warnings', { ...dashboard, warnings: [42] }],
])('browser RPC rejects successful usage with %s and accepts a later valid result', async (_name, invalid) => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message: { id: string } = JSON.parse(await request.text());
      return new Response(JSON.stringify(success(message.id, requests++ === 0 ? invalid : dashboard)));
    },
  });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const [outcome] = await Promise.allSettled([client.getUsage()]);
    expect(outcome).toMatchObject({ status: 'rejected', reason: { message: unavailable } });
    expect(await client.getUsage()).toEqual(dashboard);
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});

test('browser RPC accepts legacy usage without optional fields and retains additional fields', async () => {
  const without = (value: object, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const legacy = {
    ...without(dashboard, ['tokenCosts', 'projectInsights']),
    filters: without(dashboard.filters, ['selectedModels']),
    daily: dashboard.daily.map((bucket) => without(bucket, ['providers', 'models', 'projects'])),
    hourly: dashboard.hourly.map((bucket) => without(bucket, ['providers', 'models', 'projects'])),
  };
  const compatible = { ...legacy, futureField: 'preserved' };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message: { id: string } = JSON.parse(await request.text());
      return new Response(JSON.stringify(success(message.id, compatible)));
    },
  });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    expect<unknown>(await client.getUsage()).toEqual(compatible);
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});

test('browser RPC ignores unrelated envelopes before the matching result', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const message: { id: string } = JSON.parse(await request.text());
      return new Response(
        [{ _tag: 'Pong' }, success(message.id + '-other'), success(message.id)]
          .map((envelope) => JSON.stringify(envelope))
          .join('\n') + '\n',
      );
    },
  });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    expect(await client.getDevices()).toEqual([]);
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});

test('disposing the browser client aborts pending reads and finalizes server work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-browser-dispose-'));
  const started = Promise.withResolvers<void>();
  let finalized = false;
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret: 'test-browser-dispose-pairing-secret' },
    Layer.succeed(LocalUsage, {
      device: { id: 'test-hub', name: 'Test hub', platform: 'linux' },
      collect: Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const outcome = Promise.allSettled([client.getUsage()]);
    await started.promise;
    await client.dispose();
    expect((await outcome)[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    for (let attempt = 0; attempt < 100 && !finalized; attempt += 1) await Bun.sleep(10);
    expect(finalized).toBe(true);
    await client.dispose();
  } finally {
    await client.dispose();
    await server.stop(true);
    await handler.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pre-cancelled requests and disposed clients do not send HTTP traffic', async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response(null);
    },
  });
  const client = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const controller = new AbortController();
    controller.abort();
    const [cancelled] = await Promise.allSettled([client.getDevices(controller.signal)]);
    expect(cancelled).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    await client.dispose();
    const [disposed] = await Promise.allSettled([client.getDevices()]);
    expect(disposed).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    await Bun.sleep(10);
    expect(requests).toBe(0);
  } finally {
    await client.dispose();
    await server.stop(true);
  }
});
