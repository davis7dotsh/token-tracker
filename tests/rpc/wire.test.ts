import { afterEach, expect, jest, test } from 'bun:test';
import { Cause, Effect, Layer, ManagedRuntime, Option } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient, rpcClientLayer, UsageClient } from '../../src/lib/client/rpc';
import { handleRpcRequest, LocalUsage, makeRpcWebHandler } from '../../src/lib/server/rpc/server';
import type { UsageEvent } from '../../src/lib/shared/domain';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const pairingSecret = 'test-rpc-wire-pairing-secret';
const localDevice = Object.freeze({ id: 'hub-device', name: 'Hub', platform: 'linux' });
const localEvent: UsageEvent = {
  id: 'local-request',
  timestamp: new Date().toISOString(),
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  project: '/work/app',
  repository: 'github.com/ben/app',
  sessionId: 'local-session',
  deviceId: localDevice.id,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.01,
  costKnown: true,
};
const localData = { events: [localEvent], sources: [], warnings: [], pricingUpdatedAt: '2026-10-03T00:00:00.000Z' };

test('legacy uploads gain session titles and T3 links through metadata-only RPC corrections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-session-metadata-'));
  directories.push(directory);
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, {
      device: localDevice,
      collect: Effect.succeed({ ...localData, events: [] }),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  const browser = makeDashboardClient(endpoint);
  const device = { id: 'thread-laptop', name: 'Thread laptop', platform: 'linux' };
  try {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    const upload = (event: UsageEvent) =>
      runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({
            deviceId: device.id,
            token: registration.token,
            batch: { device, events: [event] },
          }),
        ),
      );
    expect(await upload(localEvent)).toMatchObject({ accepted: 1, updated: 0 });
    expect((await browser.getUsage()).sessions[0]?.sessionTitle).toBeUndefined();
    const metadata = {
      sessionTitle: 'Improve session navigation',
      projectName: 'Token tracker',
      t3ThreadId: 'thread-1',
      t3ThreadUrl: 'https://t3.example/thread/thread-1',
    };
    const enriched = { ...localEvent, ...metadata };
    expect(await upload(enriched)).toMatchObject({ accepted: 0, updated: 1 });
    expect(await upload(enriched)).toMatchObject({ accepted: 0, updated: 0 });
    const dashboard = await browser.getUsage();
    expect(dashboard.sessions[0]).toMatchObject(metadata);
    expect(dashboard.totals).toMatchObject({ tokens: 175, sessions: 1 });
    expect(await upload({ ...enriched, sessionTitle: 'Renamed thread' })).toMatchObject({
      accepted: 0,
      updated: 1,
    });
    expect((await browser.getUsage()).sessions[0]?.sessionTitle).toBe('Renamed thread');
    // Optional T3 metadata can be missing during a transient local DB failure
    // or when an older collector sends a genuine accounting correction.
    expect(await upload(localEvent)).toMatchObject({ accepted: 0, updated: 0 });
    expect(await upload({ ...localEvent, outputTokens: 80 })).toMatchObject({ accepted: 0, updated: 1 });
    expect(await upload({ ...localEvent, outputTokens: 80 })).toMatchObject({ accepted: 0, updated: 0 });
    const corrected = await browser.getUsage();
    expect(corrected.sessions[0]).toMatchObject({ ...metadata, sessionTitle: 'Renamed thread' });
    expect(corrected.totals).toMatchObject({ tokens: 205, sessions: 1 });
    // Scratch cwd fallbacks must not erase the saved attached repository when
    // an optional binding is temporarily absent, including older-client uploads.
    for (const repository of [null, 'local:/work/app']) {
      expect(await upload({ ...localEvent, outputTokens: 90, repository })).toMatchObject({ updated: 1 });
      expect(await upload({ ...localEvent, outputTokens: 90, repository })).toMatchObject({ updated: 0 });
      const filtered = await browser.getUsage({ projects: ['github.com/ben/app'] });
      expect(filtered.sessions[0]?.repository).toBe(localEvent.repository);
      expect(filtered.totals).toMatchObject({ tokens: 215, sessions: 1 });
      // A readable binding can confirm removal of an attached remote.
      expect(await upload({ ...localEvent, outputTokens: 90, repository, t3ThreadId: 'thread-1' })).toMatchObject({
        updated: 1,
      });
      expect((await browser.getUsage()).sessions[0]?.repository).toBe(repository);
      await upload({ ...localEvent, outputTokens: 80, ...metadata, sessionTitle: 'Renamed thread' });
    }
    // A newly resolved cwd remote is authoritative even without T3 metadata.
    await upload({ ...localEvent, outputTokens: 80, repository: 'github.com/ben/moved' });
    expect((await browser.getUsage()).sessions[0]?.repository).toBe('github.com/ben/moved');
    await upload({ ...localEvent, outputTokens: 80, ...metadata, sessionTitle: 'Renamed thread' });
    expect(await upload({ ...localEvent, outputTokens: 80, t3ThreadId: 'thread-2' })).toMatchObject({
      accepted: 0,
      updated: 1,
    });
    const changedThread = (await browser.getUsage()).sessions[0];
    expect(changedThread?.sessionTitle).toBe('Renamed thread');
    expect(changedThread?.t3ThreadId).toBe('thread-2');
    expect(changedThread?.t3ThreadUrl).toBeUndefined();
    expect(
      await upload({ ...localEvent, outputTokens: 80, t3ThreadUrl: 'https://t3.example/thread/thread-3' }),
    ).toMatchObject({
      accepted: 0,
      updated: 1,
    });
    const changedUrl = (await browser.getUsage()).sessions[0];
    expect(changedUrl?.t3ThreadId).toBeUndefined();
    expect(changedUrl?.t3ThreadUrl).toBe('https://t3.example/thread/thread-3');
    expect(await upload({ ...localEvent, outputTokens: 80, t3ThreadId: 'thread-3', t3ThreadUrl: '' })).toMatchObject({
      accepted: 0,
      updated: 1,
    });
    expect(await upload({ ...localEvent, outputTokens: 80 })).toMatchObject({ accepted: 0, updated: 0 });
    const deletedThread = (await browser.getUsage()).sessions[0];
    expect(deletedThread?.sessionTitle).toBe('Renamed thread');
    expect(deletedThread?.t3ThreadId).toBe('thread-3');
    expect(deletedThread?.t3ThreadUrl).toBeUndefined();
  } finally {
    await browser.dispose();
    await runtime.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('Grok aggregate usage preserves calls, native cost, copied-device accounting, and pricing resets over RPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-grok-'));
  directories.push(directory);
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, { device: localDevice, collect: Effect.succeed({ ...localData, events: [] }) }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  const browser = makeDashboardClient(endpoint);
  const model = 'grok-4.7-build-fast';
  const reportedCostUsd = 0.02673624;
  const event: UsageEvent = {
    ...localEvent,
    harness: 'grok',
    id: 'grok:turn:session:1:' + model,
    model,
    rawModel: model,
    requests: 3,
    reportedCostUsd,
    costUsd: reportedCostUsd,
    serviceTier: '',
  };
  try {
    for (const id of ['grok-device', 'copied-grok-device']) {
      const device = { id, name: id, platform: 'darwin' };
      const registration = await runtime.runPromise(
        Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
      );
      expect(
        await runtime.runPromise(
          Effect.flatMap(UsageClient, (client) =>
            client.SyncUsage({
              deviceId: id,
              token: registration.token,
              batch: {
                device,
                events: [event],
                sources: [{ harness: 'grok', path: '/.grok/sessions', files: 1, events: 1, status: 'ready' }],
              },
            }),
          ),
        ),
      ).toMatchObject({ accepted: 1, updated: 0 });
    }
    const usage = await browser.getUsage({ harnesses: ['grok'] });
    expect(usage.totals).toMatchObject({ tokens: 175, requests: 3, sessions: 1, costUSD: reportedCostUsd });
    expect(usage.filters.providers).toEqual(['xai']);
    expect(usage.sessions[0]).toMatchObject({ harness: 'grok', requests: 3 });
    expect((await browser.getUsage({ devices: ['grok-device'] })).totals.requests).toBe(3);
    await browser.setPricingRule({ model, kind: 'free' }, pairingSecret);
    expect((await browser.getUsage({ harnesses: ['grok'] })).totals.costUSD).toBe(0);
    await browser.deletePricingRule(model, pairingSecret);
    expect((await browser.getUsage({ harnesses: ['grok'] })).totals.costUSD).toBe(reportedCostUsd);
  } finally {
    await browser.dispose();
    await runtime.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('browser and CLI use the actual Effect RPC HTTP wire with typed errors and authenticated retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-wire-'));
  directories.push(directory);
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, { device: localDevice, collect: Effect.succeed(localData) }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  const browser = makeDashboardClient(endpoint);
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect((await browser.getUsage()).totals.tokens).toBe(175);
    expect((await browser.getDevices())[0]?.name).toBe('Hub');

    const device = { id: 'laptop', name: 'Laptop', platform: 'darwin' };
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    const batch = {
      device,
      events: [{ ...localEvent, id: 'laptop-request', deviceId: 'spoofed-device', outputTokens: 200 }],
    };
    const upload = () =>
      runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({ deviceId: device.id, token: registration.token, batch }),
        ),
      );
    expect(await upload()).toMatchObject({ accepted: 1, updated: 0 });
    expect(await upload()).toMatchObject({ accepted: 0, updated: 0 });
    const dashboard = await browser.getUsage();
    expect(dashboard.totals.tokens).toBe(500);
    expect(dashboard.filters.devices).toEqual(['hub-device', 'laptop']);
    expect((await browser.getUsage({ devices: ['laptop'] })).totals.tokens).toBe(325);

    const denied = await runtime.runPromiseExit(
      Effect.flatMap(UsageClient, (client) => client.SyncUsage({ deviceId: device.id, token: 'incorrect', batch })),
    );
    expect(denied._tag).toBe('Failure');
    if (denied._tag === 'Failure') {
      const error = Cause.findErrorOption(denied.cause);
      expect(Option.isSome(error) && error.value._tag).toBe('Unauthorized');
    }

    // A host may also run its sync agent. Its live local records replace that
    // device's uploaded history when constructing the hub view.
    const localRegistration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device: localDevice })),
    );
    await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) =>
        client.SyncUsage({
          deviceId: localDevice.id,
          token: localRegistration.token,
          batch: { device: localDevice, events: [{ ...localEvent, outputTokens: 999 }] },
        }),
      ),
    );
    expect((await browser.getUsage()).totals.tokens).toBe(500);

    const copiedDevice = { id: 'copied-laptop', name: 'Copied laptop', platform: 'linux' };
    const copiedRegistration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device: copiedDevice })),
    );
    await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) =>
        client.SyncUsage({
          deviceId: copiedDevice.id,
          token: copiedRegistration.token,
          batch: { ...batch, device: copiedDevice },
        }),
      ),
    );
    const copiedDashboard = await browser.getUsage();
    expect(copiedDashboard.totals.tokens).toBe(500);
    expect(copiedDashboard.filters.devices).toEqual(['copied-laptop', 'hub-device', 'laptop']);
    expect((await browser.getUsage({ devices: [copiedDevice.id] })).totals.tokens).toBe(325);
    const visibleDevices = await browser.getDevices();
    expect(visibleDevices.find((item) => item.id === copiedDevice.id)?.eventCount).toBe(1);
    const readOnlyData = JSON.stringify({ dashboard: copiedDashboard, devices: visibleDevices });
    expect(readOnlyData).not.toContain(pairingSecret);
    expect(readOnlyData).not.toContain(registration.token);
    expect(readOnlyData).not.toContain(copiedRegistration.token);
  } finally {
    await browser.dispose();
    await runtime.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('pricing snapshots stay attached to records across incremental uploads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-pricing-'));
  directories.push(directory);
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, { device: localDevice, collect: Effect.succeed({ ...localData, events: [] }) }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  const browser = makeDashboardClient(endpoint);
  const device = { id: 'price-laptop', name: 'Price laptop', platform: 'linux' };
  try {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    const upload = (events: readonly UsageEvent[], pricingUpdatedAt: string) =>
      runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({
            deviceId: device.id,
            token: registration.token,
            batch: { device, events, pricingUpdatedAt },
          }),
        ),
      );
    const first = { ...localEvent, id: 'old-price-record', costUsd: 1 };
    const second = { ...localEvent, id: 'new-price-record', costUsd: 2 };
    await upload([first], '2026-09-01');
    await upload([second], '2026-10-03');
    const mixed = await browser.getUsage();
    expect(mixed.totals.costUSD).toBe(3);
    expect(mixed.pricing.updatedAt).toBe('2026-09-01, 2026-10-03');
    expect(mixed.warnings.some((warning) => warning.includes('different snapshots'))).toBe(true);
    await upload([{ ...localEvent, id: 'unpriced-record', costUsd: 10, costKnown: false }], '2026-10-03');
    const unpriced = await browser.getUsage();
    expect(unpriced.totals.costUSD).toBe(3);
    expect(unpriced.totals.unpricedTokens).toBe(175);
    expect(await upload([first], '2026-10-03')).toMatchObject({ accepted: 0, updated: 1 });
    const aligned = await browser.getUsage();
    expect(aligned.pricing.updatedAt).toBe('2026-10-03');
    expect(aligned.warnings.some((warning) => warning.includes('different snapshots'))).toBe(false);
  } finally {
    await browser.dispose();
    await runtime.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('an already cancelled SvelteKit request does not initialize the shared runtime', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await handleRpcRequest(
    new Request('http://localhost/rpc', { method: 'POST', signal: controller.signal }),
  );
  expect(response.status).toBe(499);
});

test('pricing rules merge aliases in dashboard reads, reprice history, and survive reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-alias-wire-'));
  directories.push(directory);
  const events: UsageEvent[] = ['quasar-alpha', 'gpt-6.1-sol'].map((model, index) => ({
    ...localEvent,
    id: `model-${index}`,
    model,
    harness: 'codex',
    costKnown: false,
    costUsd: 0,
    serviceTier: '',
    cacheWrite1hTokens: 0,
  }));
  const localLayer = Layer.succeed(LocalUsage, {
    device: localDevice,
    collect: Effect.succeed({ ...localData, events }),
  });
  let handler = makeRpcWebHandler({ dataDirectory: directory, pairingSecret }, localLayer);
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const before = await browser.getUsage();
    expect(before.totals.unpricedTokens).toBe(175);
    expect((await browser.getPricing()).unresolved.map((entry) => entry.model)).toEqual(['quasar-alpha']);
    const initialPolicy = await browser.getPricingPolicy();
    expect(initialPolicy).not.toBeNull();
    await browser.setPricingRule({ model: 'quasar-alpha', kind: 'alias', target: 'gpt-6.1-sol' }, pairingSecret);
    const merged = await browser.getUsage({ models: ['quasar-alpha', 'gpt-6.1-sol'] });
    expect(merged.totals.tokens).toBe(350);
    expect(merged.totals.unpricedTokens).toBe(0);
    expect(merged.totals.costUSD).toBeGreaterThan(before.totals.costUSD);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]?.name).toBe('gpt-6.1-sol');
    expect(merged.providers[0]?.name).toBe('openai');
    expect(merged.filters.selectedModels).toEqual(['gpt-6.1-sol']);
    expect(JSON.stringify(merged)).not.toContain('quasar-alpha');
    expect((await browser.getPricing()).info.rules[0]?.model).toBe('quasar-alpha');
    const policy = await browser.getPricingPolicy(initialPolicy?.revision);
    expect(policy?.revision).not.toBe(initialPolicy?.revision);
    expect(await browser.getPricingPolicy(policy?.revision)).toBeNull();
    await handler.dispose();
    handler = makeRpcWebHandler({ dataDirectory: directory, pairingSecret }, localLayer);
    expect((await browser.getUsage()).models[0]?.name).toBe('gpt-6.1-sol');
    await browser.setPricingRule(
      {
        model: 'quasar-alpha',
        kind: 'rates',
        nickname: 'Private model',
        rates: {
          inputPerMillion: 2,
          outputPerMillion: 8,
          cacheReadPerMillion: 0.2,
          cacheWritePerMillion: 2.5,
          cacheWrite1hPerMillion: 4,
        },
      },
      pairingSecret,
    );
    const custom = await browser.getUsage({ models: ['quasar-alpha'] });
    expect(custom.models[0]?.name).toBe('Private model');
    expect(custom.totals.costUSD).toBeCloseTo(0.000605, 12);
    expect(custom.filters.selectedModels).toEqual(['Private model']);
  } finally {
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('pricing writes require a same-origin dashboard request or pairing secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-pricing-auth-'));
  directories.push(directory);
  const publicOrigin = 'http://personal-hub.test';
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret, dashboardOrigin: publicOrigin },
    Layer.succeed(LocalUsage, { device: localDevice, collect: Effect.succeed(localData) }),
  );
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const reconstructed = new URL(request.url);
      reconstructed.protocol = 'https:';
      return handler.handler(new Request(reconstructed, request));
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = makeDashboardClient(`${origin}/rpc`);
  const rule = { model: 'private-id', kind: 'free' as const };
  const rawWrite = (headers: Record<string, string>) =>
    fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/ndjson', ...headers },
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'SetPricingRule',
          payload: { rule, adminSecret: '' },
          headers: [],
        }) + '\n',
    });
  try {
    expect(browser.setPricingRule(rule)).rejects.toThrow('Pricing changes require');
    expect((await browser.getPricing()).info.rules).toEqual([]);
    expect((await rawWrite({ origin: 'http://other-host.example' })).status).toBe(403);
    expect(await (await rawWrite({ 'x-token-tracker-pricing-access': 'spoofed' })).text()).toContain('Unauthorized');
    const allowed = await rawWrite({ origin: publicOrigin });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).not.toContain('Unauthorized');
    expect((await browser.getPricing()).info.rules).toEqual([rule]);
    await browser.deletePricingRule(rule.model, pairingSecret);
    const settings = await browser.getPricing();
    expect(settings.info.rules).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain(pairingSecret);
    expect(JSON.stringify(await browser.getPricingPolicy())).not.toContain(pairingSecret);
  } finally {
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('browser abort cancels an in-flight RPC and finalizes its server operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-abort-'));
  directories.push(directory);
  let started = false;
  let finalized = false;
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, {
      device: localDevice,
      collect: Effect.sync(() => {
        started = true;
      }).pipe(
        Effect.andThen(Effect.sleep('10 seconds')),
        Effect.as(localData),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  try {
    const controller = new AbortController();
    const pending = browser.getUsage({}, controller.signal);
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) await Bun.sleep(10);
    expect(started).toBe(true);
    controller.abort();
    expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    for (let attempt = 0; attempt < 100 && !finalized; attempt += 1) await Bun.sleep(10);
    expect(finalized).toBe(true);
  } finally {
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('a stalled HTTP read times out, finalizes the server operation, and can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-timeout-'));
  directories.push(directory);
  let slow = true;
  let finalized = false;
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, {
      device: localDevice,
      collect: Effect.suspend(() =>
        slow
          ? Effect.sleep('10 seconds').pipe(
              Effect.as(localData),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            )
          : Effect.succeed(localData),
      ),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`, { requestTimeoutMs: 100 });
  try {
    expect(browser.getUsage()).rejects.toThrow('The dashboard took too long to respond. Try again.');
    for (let attempt = 0; attempt < 100 && !finalized; attempt += 1) await Bun.sleep(10);
    expect(finalized).toBe(true);
    slow = false;
    expect((await browser.getUsage()).totals.tokens).toBe(175);
  } finally {
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('an offline HTTP server produces a friendly bounded browser failure', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  await server.stop(true);
  const browser = makeDashboardClient(endpoint, { requestTimeoutMs: 200 });
  try {
    const started = Date.now();
    expect(browser.getUsage()).rejects.toThrow('Could not reach the dashboard. Check your connection and try again.');
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    await browser.dispose();
  }
});

test('default usage requests keep waiting after ten seconds and accept a slower healthy response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-default-slow-'));
  directories.push(directory);
  const started = Promise.withResolvers<void>();
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, {
      device: localDevice,
      collect: Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.sleep('11 seconds')),
        Effect.as(localData),
      ),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  jest.useFakeTimers({ now: new Date() });
  try {
    let settled = false;
    const pending = browser.getUsage().finally(() => {
      settled = true;
    });
    const outcome = Promise.allSettled([pending]);
    await started.promise;
    jest.advanceTimersByTime(10_001);
    // Real HTTP traffic lets transport cancellation and promise callbacks drain.
    await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(settled).toBe(false);
    jest.advanceTimersByTime(999);
    expect((await outcome)[0]).toMatchObject({ status: 'fulfilled', value: { totals: { tokens: 175 } } });
  } finally {
    jest.useRealTimers();
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('default stalled usage requests stop at thirty seconds and finalize the server operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-default-stalled-'));
  directories.push(directory);
  const started = Promise.withResolvers<void>();
  const finalized = Promise.withResolvers<void>();
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, {
      device: localDevice,
      collect: Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => finalized.resolve())),
      ),
    }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  jest.useFakeTimers({ now: new Date() });
  try {
    let settled = false;
    const pending = browser.getUsage().finally(() => {
      settled = true;
    });
    const outcome = Promise.allSettled([pending]);
    await started.promise;
    jest.advanceTimersByTime(29_999);
    await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect((await outcome)[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'The dashboard took too long to respond. Try again.' },
    });
    await finalized.promise;
  } finally {
    jest.useRealTimers();
    await browser.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});

test('default metadata requests retain their ten-second deadline', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === '/ping') return new Response('ok');
      started.resolve();
      return release.promise;
    },
  });
  const browser = makeDashboardClient(`http://127.0.0.1:${server.port}/rpc`);
  jest.useFakeTimers({ now: new Date() });
  try {
    let settled = false;
    const pending = browser.getDevices().finally(() => {
      settled = true;
    });
    const outcome = Promise.allSettled([pending]);
    await started.promise;
    jest.advanceTimersByTime(9_999);
    await fetch(`http://127.0.0.1:${server.port}/ping`);
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect((await outcome)[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'The dashboard took too long to respond. Try again.' },
    });
  } finally {
    jest.useRealTimers();
    release.resolve(new Response(null, { status: 499 }));
    await browser.dispose();
    await server.stop(true);
  }
});

test('browser and native RPC clients preserve custom endpoints without a redirect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-endpoint-'));
  directories.push(directory);
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, { device: localDevice, collect: Effect.succeed(localData) }),
  );
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/bridge/tracker/') return Response.redirect(new URL('/bridge/tracker', url), 308);
      if (url.pathname !== '/bridge/tracker' || (url.search && url.search !== '?client=native'))
        return new Response('Unknown endpoint', { status: 404 });
      return handler.handler(new Request(new URL('/rpc', url), request));
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/bridge/tracker`;
  const browser = makeDashboardClient(endpoint);
  const native = ManagedRuntime.make(rpcClientLayer(`${endpoint}?client=native`));
  try {
    expect((await browser.getUsage()).totals.tokens).toBe(175);
    expect((await native.runPromise(Effect.flatMap(UsageClient, (client) => client.GetDevices())))[0]?.name).toBe(
      'Hub',
    );
    expect(requests).toEqual(['/bridge/tracker', '/bridge/tracker?client=native']);
  } finally {
    await browser.dispose();
    await native.dispose();
    await server.stop(true);
    await handler.dispose();
  }
});
