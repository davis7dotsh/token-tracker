import { expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient } from '../../src/lib/client/dashboard-rpc';
import { LocalUsage, makeRpcWebHandler } from '../../src/lib/server/rpc/server';

const unavailable = 'Could not load usage. Try again.';
const success = (requestId: string) => ({ _tag: 'Exit', requestId, exit: { _tag: 'Success', value: [] } });

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
