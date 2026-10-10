import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient, rpcClientLayer, UsageClient } from '../../src/lib/client/rpc';
import { LocalUsage, makeRpcWebHandler, usageStoreLayer } from '../../src/lib/server/rpc/server';
import { UsageStore } from '../../src/lib/server/rpc/store';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';
import { CollectionError, type UsageEvent, type DeviceRegistration } from '../../src/lib/shared/domain';

const directories: string[] = [];
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-performance-'));
  directories.push(directory);
  return directory;
};
const pairingSecret = 'isolated-performance-test-pairing-secret';
const localDevice = Object.freeze({ id: 'performance-hub', name: 'Hub', platform: 'linux' });
const remoteDevice = { id: 'performance-remote', name: 'Remote', platform: 'darwin' };
const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'performance-request',
  timestamp: new Date().toISOString(),
  harness: 'codex',
  model: 'performance-unknown-model',
  project: '/work/app',
  repository: null,
  sessionId: 'performance-session',
  inputTokens: 100,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costKnown: false,
  serviceTier: '',
  cacheWrite1hTokens: 0,
  ...overrides,
});
const usage = (events: readonly UsageEvent[]) => ({
  events: [...events],
  sources: [],
  warnings: [],
  pricingUpdatedAt: '',
});
const storeRuntime = async () => {
  const directory = await temporary();
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  disposers.push(() => runtime.dispose());
  return { directory, runtime };
};
const hub = async (collect: Effect.Effect<ReturnType<typeof usage>, CollectionError>) => {
  const directory = await temporary();
  const handler = makeRpcWebHandler(
    { dataDirectory: directory, pairingSecret },
    Layer.succeed(LocalUsage, { device: localDevice, collect }),
  );
  const server = Bun.serve({ port: 0, fetch: (request) => handler.handler(request) });
  const endpoint = `http://127.0.0.1:${server.port}/rpc`;
  const browser = makeDashboardClient(endpoint);
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  disposers.push(async () => {
    await browser.dispose();
    await runtime.dispose();
    await server.stop(true);
    await handler.dispose();
  });
  const register = async (device: DeviceRegistration) => {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageClient, (client) => client.RegisterDevice({ pairingSecret, device })),
    );
    return (events: readonly UsageEvent[]) =>
      runtime.runPromise(
        Effect.flatMap(UsageClient, (client) =>
          client.SyncUsage({ deviceId: device.id, token: registration.token, batch: { device, events } }),
        ),
      );
  };
  return { browser, register };
};

test('indexed windows retain accepted offset formats and preserve original timestamp payloads', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
      const timestamps = [
        '2026-10-03T01:00:00+0000',
        '2026-10-03T03:00:00+0200',
        '2026-10-02T20:00:00-0500',
        '2026-10-03T03:00:00+02:00',
        '2026-10-03T01:00:00.0009Z',
        '2026-10-02T23:59:59.9999Z',
        '2026-10-04T00:00:00Z',
      ];
      const events = timestamps.map((timestamp, index) => event({ id: `offset-${index}`, timestamp }));
      yield* store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events });
      const selected = yield* store.getUsage(undefined, {
        start: '2026-10-03T00:00:00.000Z',
        end: '2026-10-04T00:00:00.000Z',
      });
      expect(selected.events.map((record) => record.id).sort()).toEqual([
        'offset-0',
        'offset-1',
        'offset-2',
        'offset-3',
        'offset-4',
      ]);
      for (const record of selected.events)
        expect(events.find((original) => original.id === record.id)?.timestamp).toBe(record.timestamp);
    }),
  );
});

test('legacy timestamp migration backfills dimensions without rewriting payloads or accounting hashes', async () => {
  const directory = await temporary();
  const filename = join(directory, 'usage.sqlite');
  const original = event({ timestamp: '2026-10-03T03:00:00+0200', deviceId: remoteDevice.id });
  const payload = JSON.stringify(original);
  const database = new Database(filename);
  database.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT NOT NULL, last_seen TEXT, sources TEXT NOT NULL DEFAULT '[]', pricing_updated_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE usage_events (device_id TEXT NOT NULL, id TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, pricing_snapshot TEXT NOT NULL DEFAULT '', PRIMARY KEY (device_id, id));`);
  database
    .query('INSERT INTO devices (id, name, platform, token_hash) VALUES (?, ?, ?, ?)')
    .run(remoteDevice.id, remoteDevice.name, remoteDevice.platform, 'existing-credential-hash');
  database
    .query('INSERT INTO usage_events (device_id, id, timestamp, payload, payload_hash) VALUES (?, ?, ?, ?, ?)')
    .run(remoteDevice.id, original.id, original.timestamp, payload, 'existing-accounting-hash');
  database.close();
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* UsageStore;
        const selected = yield* store.getUsage(undefined, {
          start: '2026-10-03T00:00:00.000Z',
          end: '2026-10-04T00:00:00.000Z',
        });
        expect(selected.events).toEqual([original]);
        expect((yield* store.getDevices())[0]?.eventCount).toBe(1);
        expect(yield* store.getDimensions()).toEqual([
          { deviceId: remoteDevice.id, harness: original.harness, model: original.model, project: original.project },
        ]);
      }),
    );
  } finally {
    await runtime.dispose();
  }
  const migrated = new Database(filename, { readonly: true });
  try {
    expect(migrated.query('SELECT timestamp, payload, payload_hash FROM usage_events').get()).toEqual({
      timestamp: '2026-10-03T01:00:00.000Z',
      payload,
      payload_hash: 'existing-accounting-hash',
    });
  } finally {
    migrated.close();
  }
});

test('a local in-window record still loses to a larger remote copy outside the window', async () => {
  const current = event({ deviceId: localDevice.id });
  const { browser, register } = await hub(Effect.succeed(usage([current])));
  const upload = await register(remoteDevice);
  await upload([{ ...current, inputTokens: 200, timestamp: new Date(Date.now() - 4 * 86_400_000).toISOString() }]);
  expect((await browser.getUsage({ range: 'today' })).totals.tokens).toBe(0);
  expect((await browser.getUsage({ range: 'all' })).totals.tokens).toBe(200);
  expect((await browser.getUsage({ range: 'today', devices: [localDevice.id] })).totals.tokens).toBe(100);
});

test('large local candidate sets use indexed owner lookups without exceeding SQLite parameter limits', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
      const outside = event({ timestamp: '2026-09-01T00:00:00.000Z' });
      yield* store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events: [outside] });
      const selected = yield* store.getUsage(undefined, {
        start: '2026-10-03T00:00:00.000Z',
        end: '2026-10-04T00:00:00.000Z',
        candidateIds: [...Array.from({ length: 260_000 }, (_, index) => `local-${index}`), outside.id],
      });
      expect(selected.events).toEqual([{ ...outside, deviceId: remoteDevice.id }]);
    }),
  );
});

test('copied-owner lookup refreshes after new owners and preserves corrected winners', async () => {
  const { browser, register } = await hub(Effect.succeed(usage([])));
  const upload = await register(remoteDevice);
  const current = event();
  await upload([current]);
  expect((await browser.getUsage({ range: 'today' })).totals.tokens).toBe(100);
  const copyDevice = { ...remoteDevice, id: 'performance-copy' };
  const copiedUpload = await register(copyDevice);
  const outside = { ...current, timestamp: new Date(Date.now() - 4 * 86_400_000).toISOString() };
  await copiedUpload([{ ...outside, inputTokens: 200 }]);
  expect((await browser.getUsage({ range: 'today' })).totals.tokens).toBe(0);
  expect((await browser.getUsage({ range: 'today', devices: [remoteDevice.id] })).totals.tokens).toBe(100);
  await copiedUpload([{ ...outside, inputTokens: 50 }]);
  expect((await browser.getUsage({ range: 'today' })).totals.tokens).toBe(100);
});

test('concurrent usage and pricing readers share collection while one abort and fresh writes remain isolated', async () => {
  let collections = 0;
  const data = usage([event({ deviceId: localDevice.id })]);
  const { browser, register } = await hub(
    Effect.sync(() => {
      collections++;
    }).pipe(Effect.andThen(Effect.sleep('120 millis')), Effect.as(data)),
  );
  const upload = await register(remoteDevice);
  const controller = new AbortController();
  const cancelled = browser.getUsage({}, controller.signal).catch((error: unknown) => error);
  const surviving = browser.getPricing();
  for (let attempt = 0; attempt < 100 && !collections; attempt++) await Bun.sleep(5);
  expect(collections).toBe(1);
  await Bun.sleep(20);
  controller.abort();
  expect(await cancelled).toMatchObject({ name: 'AbortError' });
  expect((await surviving).unresolved[0]?.tokens).toBe(100);
  expect(collections).toBe(1);
  expect((await browser.getUsage({ models: ['unselected-model'] })).totals.tokens).toBe(0);
  expect(collections).toBe(1);

  await browser.setPricingRule({ model: data.events[0].model, kind: 'free' }, pairingSecret);
  const [priced, settings] = await Promise.all([browser.getUsage(), browser.getPricing()]);
  expect(priced.totals.unpricedTokens).toBe(0);
  expect(settings.unresolved).toEqual([]);
  expect(collections).toBe(1);
  await upload([event({ id: 'new-remote-request', inputTokens: 250 })]);
  expect((await browser.getUsage()).totals.tokens).toBe(350);
  expect(collections).toBe(2);
});

test('failed shared snapshots are retried immediately', async () => {
  let attempts = 0;
  const { browser } = await hub(
    Effect.suspend(() => {
      attempts++;
      return attempts === 1
        ? Effect.fail(new CollectionError({ message: 'A temporary collection failure.' }))
        : Effect.succeed(usage([event({ deviceId: localDevice.id })]));
    }),
  );
  const failure = await browser.getUsage().catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: 'A temporary collection failure.' });
  expect((await browser.getUsage()).totals.tokens).toBe(100);
  expect(attempts).toBe(2);
});

test('bulk repeated IDs and dimension changes retain exact acknowledgements and active counts', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
      const original = event();
      const final = event({
        harness: 'pi',
        rawModel: 'raw-final-model',
        model: 'display-final-model',
        project: '/work/final',
        repository: 'github.com/ben/final',
      });
      const ack = yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: remoteDevice,
        events: [original, { ...original, inputTokens: 200 }, final],
      });
      expect(ack).toMatchObject({ accepted: 1, updated: 2, deleted: 0 });
      expect((yield* store.getDevices())[0]?.eventCount).toBe(1);
      expect(yield* store.getDimensions()).toEqual([
        { deviceId: remoteDevice.id, harness: 'pi', model: 'raw-final-model', project: 'github.com/ben/final' },
      ]);
      expect((yield* store.getUsage()).events[0]).toMatchObject(final);
      expect(
        yield* store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events: [final] }),
      ).toMatchObject({ accepted: 0, updated: 0, deleted: 0 });
      expect(
        yield* store.syncUsage(remoteDevice.id, registration.token, {
          device: remoteDevice,
          events: [],
          deletedIds: [final.id, final.id],
        }),
      ).toMatchObject({ deleted: 1 });
      expect((yield* store.getDevices())[0]?.eventCount).toBe(0);
      expect(yield* store.getDimensions()).toEqual([]);
    }),
  );
});

test('metadata heartbeats reuse remote records while corrections and deletions invalidate cached windows', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
      const original = event({ timestamp: '2026-10-03T01:00:00.000Z' });
      const source = { harness: 'codex' as const, path: '/original', files: 1, events: 1, status: 'ready' as const };
      const options = { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' };
      yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: remoteDevice,
        events: [original],
        sources: [source],
        pricingUpdatedAt: 'first-pricing',
      });
      const before = yield* store.getUsage(undefined, options);
      const revision = store.getRevision();
      const heartbeat = yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: { ...remoteDevice, name: 'Renamed remote' },
        events: [],
        sources: [{ ...source, path: '/changed', events: 0, status: 'empty' }],
        pricingUpdatedAt: 'second-pricing',
      });
      expect(heartbeat).toMatchObject({ accepted: 0, updated: 0, deleted: 0 });
      expect(store.getRevision()).toBe(revision);
      const afterHeartbeat = yield* store.getUsage(undefined, options);
      expect(afterHeartbeat.events).toBe(before.events);
      expect(afterHeartbeat.sources[0]).toMatchObject({
        path: 'Renamed remote · /changed',
        status: 'empty',
        events: 0,
      });
      expect(afterHeartbeat.pricingUpdatedAt).toBe('second-pricing');

      yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: remoteDevice,
        events: [{ ...original, inputTokens: 250 }],
      });
      expect(store.getRevision()).toBeGreaterThan(revision);
      const corrected = yield* store.getUsage(undefined, options);
      expect(corrected.events).not.toBe(before.events);
      expect(corrected.events[0]?.inputTokens).toBe(250);
      yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: remoteDevice,
        events: [],
        deletedIds: [original.id],
      });
      const deleted = yield* store.getUsage(undefined, options);
      expect(deleted.events).toEqual([]);
      expect(deleted.pricingSnapshots).toEqual([]);
      expect((yield* store.getDevices())[0]?.eventCount).toBe(0);
    }),
  );
});

test('daily binary boundaries recover midnight after a timezone midnight gap', () => {
  const dashboard = buildDashboard(
    usage([event({ timestamp: '2026-09-07T03:30:00Z' })]),
    { range: '7d', timezone: 'America/Santiago' },
    new Date('2026-09-12T12:00:00Z'),
  );
  expect(dashboard.daily.filter((day) => day.tokens).map((day) => day.date)).toEqual(['2026-09-07']);
  expect(dashboard.daily.reduce((sum, day) => sum + day.tokens, 0)).toBe(dashboard.totals.tokens);
  const gapDay = buildDashboard(
    usage([]),
    { range: 'today', timezone: 'America/Santiago' },
    new Date('2026-09-06T15:00:00Z'),
  );
  expect(gapDay.daily.map((day) => day.date)).toEqual(['2026-09-06']);
  expect(gapDay.hourly).toHaveLength(23);
});
