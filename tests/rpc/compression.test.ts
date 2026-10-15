import { afterEach, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressRpcResponse } from '../../src/lib/server/rpc/compression';
import { LocalUsage, makeRpcWebHandler } from '../../src/lib/server/rpc/server';
import type { UsageEvent } from '../../src/lib/shared/domain';

const directory: string[] = [];
afterEach(async () => {
  await Promise.all(directory.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});
const contentType = 'application/ndjson';
const payload = `${JSON.stringify({ result: 'accounting metadata '.repeat(1000) })}\n`;
const request = (acceptEncoding?: string, signal?: AbortSignal) =>
  new Request('http://127.0.0.1/rpc', {
    method: 'POST',
    ...(acceptEncoding === undefined ? {} : { headers: { 'accept-encoding': acceptEncoding } }),
    ...(signal ? { signal } : {}),
  });
const response = (text = payload, extra: HeadersInit = {}) => {
  const headers = new Headers(extra);
  if (!headers.has('content-type')) headers.set('content-type', contentType);
  return new Response(text, { headers });
};

test('gzip negotiation preserves identity, explicit refusals and small response bytes', async () => {
  for (const acceptEncoding of [undefined, 'identity', '*', 'gzip;q=0', 'br, gzip;q=0, *;q=1', 'gzip;q=invalid']) {
    const result = await compressRpcResponse(request(acceptEncoding), response());
    expect(result.headers.get('content-encoding')).toBeNull();
    expect(result.headers.get('vary')).toBe('Accept-Encoding');
    expect(await result.text()).toBe(payload);
  }
  const smallHeaders: HeadersInit[] = [{}, { 'content-length': '6' }];
  for (const headers of smallHeaders) {
    const result = await compressRpcResponse(request('gzip'), response('small\n', headers));
    expect(result.headers.get('content-encoding')).toBeNull();
    expect(await result.text()).toBe('small\n');
  }
});

test('native gzip preserves response metadata and removes the original representation length', async () => {
  const original = new Response(payload, {
    status: 202,
    statusText: 'Accepted',
    headers: { 'content-type': contentType, 'content-length': String(payload.length), vary: 'Origin', etag: '"usage"' },
  });
  const result = await compressRpcResponse(request('br, GZip; q=0.5'), original);
  expect(result.status).toBe(202);
  expect(result.statusText).toBe('Accepted');
  expect(result.headers.get('content-encoding')).toBe('gzip');
  expect(result.headers.get('content-length')).toBeNull();
  expect(result.headers.get('vary')).toBe('Origin, Accept-Encoding');
  expect(result.headers.get('etag')).toBe('W/"usage"');
  const bytes = await result.bytes();
  expect(bytes.byteLength).toBeLessThan(payload.length / 20);
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(payload);
  const untouchedHeaders: HeadersInit[] = [
    { 'content-encoding': 'br' },
    { 'content-type': 'application/octet-stream' },
    { 'cache-control': 'private, no-transform' },
    { 'content-range': 'bytes 0-1023/2048' },
  ];
  for (const headers of untouchedHeaders) {
    const untouched = response(payload, headers);
    expect(await compressRpcResponse(request('gzip'), untouched)).toBe(untouched);
  }
});

test('request abort while waiting for the first chunk cancels and unlocks the original body', async () => {
  let cancelled: unknown;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    cancel: (reason) => {
      cancelled = reason;
    },
  });
  const controller = new AbortController();
  const pending = compressRpcResponse(
    request('gzip', controller.signal),
    new Response(body, { headers: { 'content-type': contentType } }),
  );
  controller.abort(new DOMException('Stopped waiting', 'AbortError'));
  expect(await pending.catch((error: unknown) => error)).toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(controller.signal.reason);
  expect(body.locked).toBe(false);
});

test('compressed response cancellation releases its source without reading the full stream', async () => {
  let pulls = 0;
  let cancelled = false;
  const bytes = crypto.getRandomValues(new Uint8Array(32 * 1024));
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await compressRpcResponse(
    request('gzip'),
    new Response(body, { headers: { 'content-type': contentType } }),
  );
  const reader = result.body!.getReader();
  await reader.read();
  await Bun.sleep(10);
  expect(pulls).toBeLessThan(20);
  await reader.cancel('finished early');
  for (let attempt = 0; attempt < 50 && !cancelled; attempt++) await Bun.sleep(1);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test('request abort during a compressed body errors its reader and cancels the original stream', async () => {
  let cancelled = false;
  let first = true;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(stream) {
      if (first) {
        first = false;
        stream.enqueue(new TextEncoder().encode(payload));
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await compressRpcResponse(
    request('gzip', controller.signal),
    new Response(body, { headers: { 'content-type': contentType } }),
  );
  const pending = result.bytes();
  controller.abort(new DOMException('Stopped reading', 'AbortError'));
  expect(await pending.catch((error: unknown) => error)).toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test('the self-hosted HTTP RPC serves gzip and identity with identical decoded dashboard accounting', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-compression-'));
  directory.push(dataDirectory);
  const device = { id: 'compression-hub', name: 'Compression hub', platform: 'linux' };
  const events: UsageEvent[] = Array.from({ length: 500 }, (_, index) => ({
    id: `compression-${index}`,
    timestamp: '2026-10-01T00:00:00.000Z',
    harness: 'codex',
    sessionId: `session-${index}`,
    model: 'gpt-6.1-sol',
    project: '/work/project',
    repository: null,
    deviceId: device.id,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    costKnown: false,
    serviceTier: '',
  }));
  const web = makeRpcWebHandler(
    { dataDirectory, pairingSecret: 'compression-test-pairing-secret' },
    Layer.succeed(LocalUsage, {
      device,
      collect: Effect.succeed({ events, sources: [], warnings: [], pricingUpdatedAt: '' }),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (incoming) => web.handler(incoming) });
  try {
    const endpoint = `http://127.0.0.1:${server.port}/rpc`;
    const call = (acceptEncoding: string, tag = 'GetUsage') =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': contentType, 'accept-encoding': acceptEncoding, origin: new URL(endpoint).origin },
        body: `${JSON.stringify({ _tag: 'Request', id: 'compression', tag, payload: tag === 'GetUsage' ? { range: 'all', timezone: 'UTC' } : null, headers: [] })}\n`,
      });
    const plain = await call('identity');
    expect(plain.headers.get('content-encoding')).toBeNull();
    const expected = await plain.text();
    const parsed: unknown = JSON.parse(expected);
    expect(parsed).toMatchObject({
      _tag: 'Exit',
      exit: { _tag: 'Success', value: { totals: { tokens: 60000, sessions: 500 } } },
    });
    const zipped = await call('gzip');
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(zipped.headers.get('vary')).toContain('Accept-Encoding');
    const compressed: unknown = JSON.parse(await zipped.text(), (key, value: unknown) =>
      key === 'generatedAt' ? undefined : value,
    );
    const uncompressed: unknown = JSON.parse(expected, (key, value: unknown) =>
      key === 'generatedAt' ? undefined : value,
    );
    expect(compressed).toEqual(uncompressed);
    const refused = await call('gzip;q=0');
    expect(refused.headers.get('content-encoding')).toBeNull();
    const declined: unknown = JSON.parse(await refused.text(), (key, value: unknown) =>
      key === 'generatedAt' ? undefined : value,
    );
    expect(declined).toEqual(uncompressed);
    const small = await call('gzip', 'GetDevices');
    expect(small.headers.get('content-encoding')).toBeNull();
    expect(await small.text()).toContain(device.id);
  } finally {
    await server.stop(true);
    await web.dispose();
  }
});
