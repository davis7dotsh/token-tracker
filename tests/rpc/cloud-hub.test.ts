import { afterEach, expect, test } from 'bun:test';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient, rpcClientLayer, UsageClient } from '../../src/lib/client/rpc';
import { makeHubWebHandler, sqlHubServices } from '../../src/lib/server/rpc/hub';
import type { UsageEvent } from '../../src/lib/shared/domain';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const pairingSecret = 'test-cloud-hub-pairing-secret';
const event: UsageEvent = {
  id: 'laptop-request',
  timestamp: new Date().toISOString(),
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  project: '/work/app',
  repository: 'github.com/ben/app',
  sessionId: 'laptop-session',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.01,
  costKnown: true,
};

// The Cloudflare hub's composition, on bun:sqlite instead of Durable Object storage.
const serve = (filename: string) => {
  const handler = makeHubWebHandler(
    sqlHubServices(pairingSecret).pipe(Layer.provide(SqliteClient.layer({ filename }))),
    { trustBrowser: false, autoRefreshPricing: false },
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  return { handler, server, endpoint: `http://127.0.0.1:${server.port}/rpc` };
};

test('a public SQL hub stores synced usage and pricing without a local device', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cloud-hub-'));
  directories.push(directory);
  const filename = join(directory, 'hub.sqlite');
  let hub = serve(filename);
  const runtime = ManagedRuntime.make(rpcClientLayer(hub.endpoint));
  let browser = makeDashboardClient(hub.endpoint);
  const device = { id: 'laptop', name: 'Laptop', platform: 'darwin' };
  try {
    expect(await browser.getDevices()).toEqual([]);
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    expect(
      await runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({ deviceId: device.id, token: registration.token, batch: { device, events: [event] } }),
        ),
      ),
    ).toMatchObject({ accepted: 1, updated: 0 });
    const usage = await browser.getUsage();
    expect(usage.machine).toBe('All devices');
    expect(usage.totals.tokens).toBe(175);
    expect(usage.filters.devices).toEqual(['laptop']);
    expect((await browser.getDevices()).map((item) => item.id)).toEqual(['laptop']);

    // Anyone can open a public dashboard, so its own origin does not authorize writes.
    const rule = { model: 'claude-sonnet-4-6', kind: 'free' as const };
    const pricing = await browser.getPricing();
    expect(pricing.secretRequired).toBe(true);
    const denied = await fetch(hub.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/ndjson', origin: new URL(hub.endpoint).origin },
      body:
        JSON.stringify({
          _tag: 'Request',
          id: '1',
          tag: 'SetPricingRule',
          payload: { rule, adminSecret: '' },
          headers: [],
        }) + '\n',
    });
    expect(await denied.text()).toContain('Unauthorized');
    expect(browser.setPricingRule(rule, 'incorrect-secret')).rejects.toThrow('Pricing changes require');
    await browser.setPricingRule(rule, pairingSecret);
    expect((await browser.getUsage()).totals.costUSD).toBe(0);

    // Usage, device credentials, and pricing rules all survive a new hub instance.
    await browser.dispose();
    await hub.server.stop(true);
    await hub.handler.dispose();
    hub = serve(filename);
    browser = makeDashboardClient(hub.endpoint);
    expect((await browser.getPricing()).info.rules).toEqual([rule]);
    expect((await browser.getUsage()).totals).toMatchObject({ tokens: 175, costUSD: 0 });
    const reopened = ManagedRuntime.make(rpcClientLayer(hub.endpoint));
    try {
      expect(
        await reopened.runPromise(
          Effect.flatMap(UsageClient, (client) =>
            client.SyncUsage({ deviceId: device.id, token: registration.token, batch: { device, events: [event] } }),
          ),
        ),
      ).toMatchObject({ accepted: 0, updated: 0 });
    } finally {
      await reopened.dispose();
    }
  } finally {
    await browser.dispose();
    await runtime.dispose();
    await hub.server.stop(true);
    await hub.handler.dispose();
  }
});

test('large sync batches upsert and withdraw records in bounded statements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cloud-batch-'));
  directories.push(directory);
  const hub = serve(join(directory, 'hub.sqlite'));
  const runtime = ManagedRuntime.make(rpcClientLayer(hub.endpoint));
  const device = { id: 'desktop', name: 'Desktop', platform: 'linux' };
  const events = Array.from({ length: 1_000 }, (_, index) => ({ ...event, id: `request-${index}` }));
  try {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    const sync = (batch: { events: UsageEvent[]; deletedIds?: string[] }) =>
      runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({ deviceId: device.id, token: registration.token, batch: { device, ...batch } }),
        ),
      );
    expect(await sync({ events })).toMatchObject({ accepted: 1_000 });
    expect(await sync({ events: [], deletedIds: events.slice(0, 600).map((item) => item.id) })).toMatchObject({
      deleted: 600,
    });
  } finally {
    await runtime.dispose();
    await hub.server.stop(true);
    await hub.handler.dispose();
  }
});

test('administrative imports authenticate, validate batches, and preserve connected collector credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-cloud-import-'));
  directories.push(directory);
  const hub = serve(join(directory, 'hub.sqlite'));
  const runtime = ManagedRuntime.make(rpcClientLayer(hub.endpoint));
  const device = { id: 'imported-device', name: 'Imported device', platform: 'linux' };
  try {
    for (const request of [
      { pairingSecret: 'incorrect-secret', batch: { device, events: [event] } },
      { pairingSecret, batch: { device, events: [{ ...event, inputTokens: -1 }] } },
    ]) {
      const denied = await runtime.runPromiseExit(Effect.flatMap(UsageClient, (client) => client.ImportUsage(request)));
      expect(denied._tag).toBe('Failure');
      expect(await runtime.runPromise(Effect.flatMap(UsageClient, (client) => client.GetDevices()))).toEqual([]);
    }
    expect(
      await runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.ImportUsage({ pairingSecret, batch: { device, events: [event] } }),
        ),
      ),
    ).toMatchObject({ accepted: 1 });
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    expect(
      await runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.ImportUsage({ pairingSecret, batch: { device, events: [{ ...event, outputTokens: 75 }] } }),
        ),
      ),
    ).toMatchObject({ updated: 1 });
    expect(
      await runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({
            deviceId: device.id,
            token: registration.token,
            batch: { device, events: [{ ...event, outputTokens: 80 }] },
          }),
        ),
      ),
    ).toMatchObject({ updated: 1 });
    const badToken = await runtime.runPromiseExit(
      Effect.flatMap(UsageClient, (client) =>
        client.SyncUsage({ deviceId: device.id, token: 'incorrect-token', batch: { device, events: [] } }),
      ),
    );
    expect(badToken._tag).toBe('Failure');
  } finally {
    await runtime.dispose();
    await hub.server.stop(true);
    await hub.handler.dispose();
  }
});
