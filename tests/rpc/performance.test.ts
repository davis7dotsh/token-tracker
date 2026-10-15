import { afterEach, expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Database } from 'bun:sqlite';
import { Clock, Deferred, Effect, Layer, ManagedRuntime } from 'effect';
import { Headers } from 'effect/http';
import { Rpc, RpcMessage } from 'effect/rpc';
import { TestClock } from 'effect/testing';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDashboardClient, rpcClientLayer, UsageClient } from '../../src/lib/client/rpc';
import { filePricingLayer, LocalUsage, makeRpcWebHandler, usageStoreLayer } from '../../src/lib/server/rpc/server';
import { HubPricing, makeLocalUsageSnapshot, rpcHandlersLayer } from '../../src/lib/server/rpc/hub';
import { defaultStored } from '../../src/lib/server/usage/pricing-store';
import { UsageStore } from '../../src/lib/server/rpc/store';
import { buildDashboard } from '../../src/lib/server/usage/dashboard';
import { collectUsage } from '../../src/lib/server/usage';
import { usageRevision } from '../../src/lib/server/usage/revision';
import { bundledPolicy } from '../../src/lib/server/usage/pricing';
import {
  CollectionError,
  type UsageEvent,
  type DeviceRegistration,
  type UsageQuery,
  type UsageResult,
  type DashboardResponse,
} from '../../src/lib/shared/domain';
import { UsageRpc, type UsageFailure, type PricingSettings } from '../../src/lib/shared/rpc';
import type { PricingFailure } from '../../src/lib/shared/pricing';

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

const controlledHub = async (
  collect: Effect.Effect<UsageResult, CollectionError>,
  revision?: (previous?: UsageResult) => Effect.Effect<string, CollectionError>,
) => {
  const directory = await temporary();
  const clock = TestClock.layer();
  const services = Layer.mergeAll(
    usageStoreLayer({ dataDirectory: directory, pairingSecret }),
    filePricingLayer({ dataDirectory: directory }),
    Layer.succeed(LocalUsage, { device: localDevice, collect, ...(revision ? { revision } : {}) }),
  );
  const handlers = rpcHandlersLayer('test-browser-proof', { trustBrowser: true, autoRefreshPricing: false }).pipe(
    Layer.provide(Layer.mergeAll(services, clock)),
  );
  const runtime = ManagedRuntime.make(Layer.mergeAll(handlers, services, clock));
  disposers.push(() => runtime.dispose());
  const options = {
    client: new Rpc.ServerClient(1),
    requestId: RpcMessage.RequestId('test-request'),
    headers: Headers.empty,
  };
  const getUsage = (query: UsageQuery = {}, signal?: AbortSignal) =>
    runtime.runPromise(
      Effect.flatMap(UsageRpc.accessHandler('GetUsage'), (handler) => handler(query, options)).pipe(
        Effect.flatMap((result) =>
          Deferred.isDeferred<DashboardResponse, UsageFailure>(result)
            ? Deferred.await(result)
            : Effect.succeed(result),
        ),
      ),
      { signal },
    );
  const getPricing = (query: UsageQuery = {}) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const handler = yield* UsageRpc.accessHandler('GetPricing');
        const result = yield* handler(query, options);
        return Deferred.isDeferred<PricingSettings, PricingFailure | UsageFailure>(result)
          ? yield* Deferred.await(result)
          : result;
      }),
    );
  const settle = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      }),
    );
  return { directory, runtime, getUsage, getPricing, settle };
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
  expect(collections).toBe(1);
});

test('eight final dashboard and pricing results outlive evicted event snapshots and long idle gaps', async () => {
  let collections = 0;
  let sourceChecks = 0;
  const { runtime, getUsage, getPricing } = await controlledHub(
    Effect.sync(() => {
      collections++;
      return usage([event({ deviceId: localDevice.id, timestamp: '2026-10-15T10:00:00.000Z' })]);
    }),
    () =>
      Effect.sync(() => {
        sourceChecks++;
        return 'unchanged-sources';
      }),
  );
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T12:00:00.000Z')));
  const queries: UsageQuery[] = [
    ...(['today', '7d', '30d', '90d', '6m', 'all'] as const).map((range) => ({ range })),
    { range: '7d', devices: [localDevice.id] },
    { range: '7d', timezone: 'America/New_York' },
  ];
  const before: DashboardResponse[] = [];
  const pricingBefore: PricingSettings[] = [];
  for (const query of queries) {
    before.push(await getUsage(query));
    pricingBefore.push(await getPricing(query));
  }
  expect(before[0].generatedAt).toBe('2026-10-15T12:00:00.000Z');
  expect(collections).toBe(1);
  expect(sourceChecks).toBe(2);
  await runtime.runPromise(TestClock.adjust('60 seconds'));
  for (const [index, query] of queries.entries()) {
    const after = await getUsage(query);
    expect(after.totals.tokens).toBe(100);
    expect(after.sessions).toBe(before[index].sessions);
    expect(after.daily).toBe(before[index].daily);
    expect(after.generatedAt).toBe('2026-10-15T12:01:00.000Z');
    expect((await getPricing(query)).unresolved).toBe(pricingBefore[index].unresolved);
  }
  expect(collections).toBe(1);
  expect(sourceChecks).toBe(3);
  await runtime.runPromise(TestClock.adjust('1 hour'));
  expect(sourceChecks).toBe(3);
  expect((await getUsage({ range: '7d' })).sessions).toBe(before[1].sessions);
  expect((await getPricing({ range: '7d' })).unresolved).toBe(pricingBefore[1].unresolved);
  expect(collections).toBe(1);
  expect(sourceChecks).toBe(4);
});

test('final result keys normalize every filter while preserving selected model order', async () => {
  const first = event({
    id: 'first',
    model: 'unknown-first',
    deviceId: localDevice.id,
    timestamp: '2026-10-15T10:00:00.000Z',
  });
  const second = event({
    id: 'second',
    sessionId: 'second-session',
    harness: 'claude',
    model: 'unknown-second',
    project: '/work/second',
    inputTokens: 250,
    deviceId: localDevice.id,
    timestamp: first.timestamp,
  });
  const { runtime, getUsage, getPricing } = await controlledHub(Effect.succeed(usage([first, second])));
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T12:00:00.000Z')));
  const queries: UsageQuery[] = [
    { range: 'all' },
    { range: 'all', harnesses: ['codex'] },
    { range: 'all', models: ['unknown-second'] },
    { range: 'all', providers: ['missing'] },
    { range: 'all', projects: ['/work/app'] },
    { range: 'all', devices: [] },
    { range: 'all', models: [] },
    { range: 'all', models: ['unknown-second', 'unknown-first', 'unknown-second'] },
  ];
  const before = await Promise.all(queries.map((query) => getUsage(query)));
  expect(before.map((result) => result.totals.tokens)).toEqual([350, 100, 250, 0, 100, 0, 0, 350]);
  for (const [index, query] of queries.entries()) {
    expect((await getUsage(query)).sessions).toBe(before[index].sessions);
    const unresolved = (await getPricing(query)).unresolved;
    expect(unresolved.reduce((sum, row) => sum + row.tokens, 0)).toBe(before[index].totals.unpricedTokens);
  }
  const reordered = await getUsage({ range: 'all', models: ['unknown-first', 'unknown-second'] });
  expect(reordered.sessions).toBe(before[7].sessions);
  expect(reordered.filters.selectedModels).toEqual(['unknown-first', 'unknown-second']);
  expect(before[7].filters.selectedModels).toEqual(['unknown-second', 'unknown-first']);
});

test('final dashboard and pricing responses follow exact event edges, rolling periods, calendar changes and reversed clocks', async () => {
  const events = [
    ['previous-edge', '2026-10-01T12:00:00.000Z'],
    ['start-edge', '2026-10-08T12:00:00.000Z'],
    ['today', '2026-10-15T00:00:00.000Z'],
    ['now-edge', '2026-10-15T12:00:00.001Z'],
    ['midnight', '2026-10-16T00:00:00.000Z'],
    ['dst-fold', '2026-11-01T06:00:00.000Z'],
  ].map(([id, timestamp], index) =>
    event({ id, sessionId: id, timestamp, deviceId: localDevice.id, inputTokens: (index + 1) * 100 }),
  );
  const { runtime, getUsage, getPricing } = await controlledHub(Effect.succeed(usage(events)), () =>
    Effect.succeed('unchanged'),
  );
  const queries: UsageQuery[] = [
    ...(['today', '7d', '30d', '90d', '6m', 'all'] as const).map((range) => ({ range })),
    { range: 'today', timezone: 'America/New_York' },
    { range: '7d', timezone: 'Invalid/Timezone' },
  ];
  for (const timestamp of [
    '2026-10-15T11:59:59.999Z',
    '2026-10-15T12:00:00.000Z',
    '2026-10-15T12:00:00.001Z',
    '2026-10-15T12:00:00.002Z',
    '2026-10-15T12:00:00.000Z',
    '2026-10-15T23:59:59.999Z',
    '2026-10-16T00:00:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-01T06:30:00.000Z',
    '2026-11-01T05:30:00.000Z',
  ]) {
    await runtime.runPromise(TestClock.setTime(Date.parse(timestamp)));
    for (const query of queries) {
      const expected = buildDashboard(
        {
          ...usage(events),
          warnings: [
            'No reliable API price for: performance-unknown-model. These tokens are included, but their costs are unavailable.',
          ],
        },
        query,
        new Date(timestamp),
      );
      const actual = await getUsage(query);
      expect(actual.generatedAt).toBe(timestamp);
      expect(actual.totals).toEqual(expected.totals);
      expect(actual.previous).toEqual(expected.previous);
      expect(actual.period).toEqual(expected.period);
      expect(actual.sessions).toEqual(expected.sessions);
      expect(actual.daily).toEqual(expected.daily);
      expect(actual.hourly).toEqual(expected.hourly);
      expect(actual.warnings).toEqual(expected.warnings);
      expect((await getPricing(query)).unresolved.reduce((sum, row) => sum + row.tokens, 0)).toBe(
        expected.totals.unpricedTokens,
      );
    }
  }
});

test('uploaded writes and pricing revisions invalidate immediately without collecting unchanged local logs', async () => {
  let collections = 0;
  const local = event({ deviceId: localDevice.id, timestamp: '2026-10-15T10:00:00.000Z' });
  const { directory, runtime, getUsage, getPricing } = await controlledHub(
    Effect.sync(() => {
      collections++;
      return {
        ...usage([local]),
        warnings: [
          `No reliable API price for: ${local.model}. These tokens are included, but their costs are unavailable.`,
        ],
      };
    }),
    () => Effect.succeed('unchanged-source'),
  );
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T12:00:00.000Z')));
  const store = await runtime.runPromise(UsageStore);
  const registration = await runtime.runPromise(store.registerDevice(pairingSecret, remoteDevice));
  const remote = event({ id: 'remote-write', inputTokens: 250, timestamp: local.timestamp });
  await runtime.runPromise(
    store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events: [remote] }),
  );
  const query = { range: 'all' as const };
  const first = await getUsage(query);
  const firstPricing = await getPricing(query);
  expect(first.totals.tokens).toBe(350);
  expect(first.warnings.some((warning) => warning.startsWith('No reliable API price for: '))).toBe(true);
  await runtime.runPromise(store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events: [] }));
  expect((await getUsage(query)).sessions).toBe(first.sessions);
  expect((await getPricing(query)).unresolved).toBe(firstPricing.unresolved);
  await runtime.runPromise(
    store.syncUsage(remoteDevice.id, registration.token, {
      device: remoteDevice,
      events: [],
      sources: [{ harness: 'codex', path: '/changed/source', files: 1, events: 1, status: 'ready' }],
    }),
  );
  const metadata = await getUsage(query);
  expect(metadata.totals.tokens).toBe(350);
  expect(metadata.sources[0]?.path).toBe('Remote · /changed/source');
  await runtime.runPromise(store.renameDevice(remoteDevice.id, 'Updated Remote'));
  const renamed = await getUsage(query);
  expect(renamed.sources[0]?.path).toBe('Updated Remote · /changed/source');
  expect(renamed.sessions).not.toBe(metadata.sessions);
  await runtime.runPromise(
    store.syncUsage(remoteDevice.id, registration.token, {
      device: remoteDevice,
      events: [{ ...remote, inputTokens: 300 }],
    }),
  );
  expect((await getUsage(query)).totals.tokens).toBe(400);
  await runtime.runPromise(
    store.syncUsage(remoteDevice.id, registration.token, { device: remoteDevice, events: [], deletedIds: [remote.id] }),
  );
  expect((await getUsage(query)).totals.tokens).toBe(100);
  await runtime.runPromise(store.importUsage(pairingSecret, { device: remoteDevice, events: [remote] }));
  const imported = await getUsage(query);
  const importedPricing = await getPricing(query);
  expect(imported.totals.tokens).toBe(350);
  await runtime.runPromise(store.importUsage(pairingSecret, { device: remoteDevice, events: [remote] }));
  expect((await getUsage(query)).sessions).toBe(imported.sessions);

  await writeFile(
    join(directory, 'pricing-state.json'),
    JSON.stringify({
      ...defaultStored(),
      checkedAt: '2026-10-15T12:00:00.000Z',
      refreshError: 'Fixture refresh unavailable.',
    }),
  );
  const currentInfo = await getPricing();
  expect(currentInfo.info.checkedAt).toBe('2026-10-15T12:00:00.000Z');
  expect(currentInfo.info.refreshError).toBe('Fixture refresh unavailable.');
  expect((await getPricing(query)).unresolved).toBe(importedPricing.unresolved);
  expect((await getUsage(query)).sessions).toBe(imported.sessions);
  const pricing = await runtime.runPromise(HubPricing);
  await runtime.runPromise(pricing.setRule({ model: local.model, kind: 'free' }));
  const free = await getUsage(query);
  expect(free.totals.unpricedTokens).toBe(0);
  expect(free.warnings).toEqual([]);
  expect((await getPricing()).unresolved).toEqual([]);
  await runtime.runPromise(pricing.deleteRule(local.model));
  const deleted = await getUsage(query);
  expect(deleted.totals.unpricedTokens).toBe(350);
  expect(deleted.warnings.some((warning) => warning.startsWith('No reliable API price for: '))).toBe(true);
  expect(collections).toBe(1);
});

test('changed local sources await one shared collection, propagate failures, retry, and cancel abandoned work', async () => {
  let collections = 0;
  let shouldFail = false;
  let inventoryFailure = false;
  let signal = 'initial';
  let tokens = 100;
  let gate = Effect.runSync(Deferred.make<void>());
  let interrupted = false;
  const { runtime, getUsage, settle } = await controlledHub(
    Effect.gen(function* () {
      collections++;
      if (collections > 1)
        yield* Deferred.await(gate).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
      if (shouldFail) return yield* new CollectionError({ message: 'Temporary source failure.' });
      return usage([event({ deviceId: localDevice.id, inputTokens: tokens, timestamp: '2026-10-15T10:00:00.000Z' })]);
    }),
    () =>
      Effect.suspend(() =>
        inventoryFailure
          ? Effect.fail(new CollectionError({ message: 'Source inventory failed.' }))
          : Effect.succeed(signal),
      ),
  );
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T12:00:00.000Z')));
  expect((await getUsage()).totals.tokens).toBe(100);
  tokens = 250;
  signal = 'changed';
  await runtime.runPromise(TestClock.adjust('6 seconds'));
  let resolved = false;
  const pending = Promise.all([getUsage(), getUsage(), getUsage()]).then((responses) => {
    resolved = true;
    return responses;
  });
  await settle();
  expect(collections).toBe(2);
  expect(resolved).toBe(false);
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  expect((await pending).every((response) => response.totals.tokens === 250)).toBe(true);

  shouldFail = true;
  signal = 'failed-change';
  await runtime.runPromise(TestClock.adjust('6 seconds'));
  expect(await getUsage().catch((error: unknown) => error)).toMatchObject({ message: 'Temporary source failure.' });
  expect(collections).toBe(3);
  shouldFail = false;
  const recovered = await getUsage();
  expect(recovered.totals.tokens).toBe(250);
  expect(recovered.warnings.every((warning) => !warning.includes('Temporary source failure.'))).toBe(true);
  expect(collections).toBe(4);

  inventoryFailure = true;
  await runtime.runPromise(TestClock.adjust('6 seconds'));
  expect(await getUsage().catch((error: unknown) => error)).toMatchObject({ message: 'Source inventory failed.' });
  inventoryFailure = false;
  expect((await getUsage()).sessions).toBe(recovered.sessions);
  expect(collections).toBe(4);

  gate = Effect.runSync(Deferred.make<void>());
  signal = 'cancelled-change';
  tokens = 400;
  await runtime.runPromise(TestClock.adjust('6 seconds'));
  const controller = new AbortController();
  const cancelled = getUsage({}, controller.signal).catch((error: unknown) => error);
  await settle();
  expect(collections).toBe(5);
  controller.abort();
  expect(await cancelled).toBeInstanceOf(Error);
  expect(interrupted).toBe(true);
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  expect((await getUsage()).totals.tokens).toBe(400);
  expect(collections).toBe(6);
});

test('local snapshot generation stays stable for unchanged data and retries an initial failure', async () => {
  let attempts = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* makeLocalUsageSnapshot(
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? Effect.fail(new CollectionError({ message: 'First attempt failed.' }))
            : Effect.succeed(
                usage([
                  event({
                    timestamp: '2026-10-15T10:00:00Z',
                    sessionTitle: attempts >= 4 ? 'Updated title' : 'Original title',
                  }),
                ]),
              );
        }),
      );
      expect((yield* Effect.result(read))._tag).toBe('Failure');
      const original = yield* read;
      yield* TestClock.adjust('6 seconds');
      expect(yield* read).toBe(original);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* read).toBe(original);
      yield* TestClock.adjust('6 seconds');
      yield* read;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const updated = yield* read;
      expect(updated.generation).toBeGreaterThan(original.generation);
      expect(updated.current.events[0].sessionTitle).toBe('Updated title');
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  expect(attempts).toBe(4);
});

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'unreadable local directories retain healthy and uploaded usage and recover on the next request',
  async () => {
    const home = await temporary();
    const claude = join(home, 'claude');
    const root = join(claude, 'projects');
    const healthy = join(root, 'healthy');
    const denied = join(root, 'denied');
    await mkdir(healthy, { recursive: true });
    await mkdir(denied, { recursive: true });
    const log = (id: string, tokens: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-15T10:00:00.000Z',
        sessionId: id,
        cwd: 'Unknown project',
        message: { id, model: 'performance-unknown-model', usage: { input_tokens: tokens, output_tokens: 0 } },
      }) + '\n';
    await writeFile(join(healthy, 'usage.jsonl'), log('readable-local', 100));
    const deniedFile = join(denied, 'usage.jsonl');
    await writeFile(deniedFile, log('denied-local', 250));
    const before = await stat(deniedFile, { bigint: true });
    const options = {
      home,
      claudeDirs: [claude],
      codexDirs: [],
      piDirs: [],
      grokDirs: [],
      museDirs: [],
      deviceId: localDevice.id,
      t3DataDirectory: join(home, 'no-t3'),
      pricingPolicy: bundledPolicy,
    };
    let collections = 0;
    const collect = Effect.sync(() => {
      collections++;
    }).pipe(Effect.andThen(collectUsage(options)), Effect.provide(BunServices.layer));
    const { runtime, getUsage } = await controlledHub(collect, (previous) =>
      usageRevision(options)(previous).pipe(Effect.provide(BunServices.layer)),
    );
    await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T12:00:00.000Z')));
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* UsageStore;
        const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
        yield* store.syncUsage(remoteDevice.id, registration.token, {
          device: remoteDevice,
          events: [
            event({
              id: 'uploaded-readable',
              sessionId: 'uploaded-readable',
              timestamp: '2026-10-15T10:00:00.000Z',
              inputTokens: 400,
            }),
          ],
        });
      }),
    );
    await chmod(denied, 0);
    try {
      const partial = await getUsage({ range: 'all' });
      expect(partial.totals.tokens).toBe(500);
      expect(partial.sessions.map((session) => session.id).sort()).toEqual(['readable-local', 'uploaded-readable']);
      expect(partial.sources.some((source) => source.path === root && source.status === 'partial')).toBe(true);
      expect(partial.warnings.some((warning) => warning.includes('1 directories could not be read.'))).toBe(true);
      const partialCollections = collections;
      expect((await getUsage({ range: 'all' })).totals.tokens).toBe(500);
      expect(collections).toBeGreaterThan(partialCollections);
    } finally {
      await chmod(denied, 0o700);
    }
    const after = await stat(deniedFile, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    const recovered = await getUsage({ range: 'all' });
    expect(recovered.totals.tokens).toBe(750);
    expect(recovered.sources.some((source) => source.path === root && source.status === 'ready')).toBe(true);
    expect(recovered.warnings.some((warning) => warning.includes('could not be read.'))).toBe(false);
    const warmedCollections = collections;
    expect((await getUsage({ range: 'all' })).sessions).toBe(recovered.sessions);
    expect(collections).toBe(warmedCollections);

    // An inaccessible configured root follows the same partial-collection
    // policy as an unreadable child and never hides uploaded accounting.
    await chmod(claude, 0);
    try {
      await runtime.runPromise(TestClock.adjust('6 seconds'));
      const unavailable = await getUsage({ range: 'all' });
      expect(unavailable.totals.tokens).toBe(400);
      expect(unavailable.sources.some((source) => source.path === root && source.status === 'error')).toBe(true);
      expect(unavailable.warnings.some((warning) => warning.includes('Usage directory could not be read.'))).toBe(true);
    } finally {
      await chmod(claude, 0o700);
    }
    expect((await getUsage({ range: 'all' })).totals.tokens).toBe(750);
  },
);

test('local source races stabilize within two collections and unstable results revalidate on the next read', async () => {
  let attempts = 0;
  let signal = 'initial';
  let keepChanging = true;
  await Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* makeLocalUsageSnapshot(
        Effect.sync(() => {
          attempts++;
          if (keepChanging) signal = `revision-${attempts}`;
          return usage([event({ timestamp: '2026-10-15T10:00:00Z', inputTokens: attempts * 100 })]);
        }),
        () => Effect.sync(() => signal),
      );
      const unstable = yield* read;
      expect(attempts).toBe(2);
      expect(unstable.current.events[0].inputTokens).toBe(200);
      keepChanging = false;
      const stabilized = yield* read;
      expect(attempts).toBe(3);
      expect(stabilized.current.events[0].inputTokens).toBe(300);
      yield* TestClock.adjust('60 seconds');
      expect(yield* read).toBe(stabilized);
      expect(attempts).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('unchanged accounting retains the latest dependency observer without recurring collection', async () => {
  let collections = 0;
  let physical = 'initial-source';
  let dependency = 'original-git-path';
  const dependencies = new WeakMap<UsageResult, string>();
  await Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* makeLocalUsageSnapshot(
        Effect.sync(() => {
          collections++;
          const next = usage([event({ timestamp: '2026-10-15T10:00:00Z' })]);
          dependencies.set(next, dependency);
          return next;
        }),
        (previous) => Effect.sync(() => `${physical}:${previous ? dependencies.get(previous) : ''}`),
      );
      const original = yield* read;
      expect(collections).toBe(2);
      physical = 'changed-source';
      dependency = 'retargeted-git-path';
      yield* TestClock.adjust('6 seconds');
      expect(yield* read).toBe(original);
      expect(collections).toBe(4);
      yield* TestClock.adjust('60 seconds');
      expect(yield* read).toBe(original);
      expect(collections).toBe(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('cached remote windows move at midnight and survive a backwards clock change', async () => {
  const { runtime, getUsage } = await controlledHub(Effect.succeed(usage([])));
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, remoteDevice);
      yield* store.syncUsage(remoteDevice.id, registration.token, {
        device: remoteDevice,
        events: [
          event({ id: 'before-midnight', timestamp: '2026-10-15T23:00:00.000Z', inputTokens: 100 }),
          event({ id: 'after-midnight', timestamp: '2026-10-16T00:00:00.000Z', inputTokens: 250 }),
        ],
      });
    }),
  );
  const query = { range: 'today' as const, timezone: 'UTC' };
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T23:59:59.999Z')));
  const before = await getUsage(query);
  expect(before.generatedAt).toBe('2026-10-15T23:59:59.999Z');
  expect(before.totals.tokens).toBe(100);
  await runtime.runPromise(TestClock.adjust('1 millis'));
  const after = await getUsage(query);
  expect(after.totals.tokens).toBe(250);
  expect(after.previous?.tokens).toBe(100);
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-15T23:59:59.999Z')));
  expect((await getUsage(query)).totals.tokens).toBe(100);
  expect(await runtime.runPromise(Clock.currentTimeMillis)).toBe(Date.parse('2026-10-15T23:59:59.999Z'));
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
      // Pairing sets a device's name; uploads never replace a dashboard rename.
      expect(afterHeartbeat.sources[0]).toMatchObject({
        path: 'Remote · /changed',
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

test('reused dashboard aggregates refresh metadata and invalidate at exact accounting boundaries', () => {
  const events = [
    event({ id: 'current-edge', timestamp: '2026-10-08T12:00:00.000Z', sessionId: 'current-edge' }),
    event({ id: 'previous-edge', timestamp: '2026-10-01T12:00:00.000Z', sessionId: 'previous-edge' }),
    event({ id: 'future-edge', timestamp: '2026-10-15T12:00:01.000Z', sessionId: 'future-edge' }),
  ];
  const data = usage(events);
  const query = { range: '7d' as const };
  const at = (timestamp: string) => buildDashboard(data, query, new Date(timestamp));
  const first = at('2026-10-15T11:59:59.000Z');
  const reused = at('2026-10-15T11:59:59.001Z');
  expect(reused.sessions).toBe(first.sessions);
  expect(reused.generatedAt).toBe('2026-10-15T11:59:59.001Z');
  for (const timestamp of [
    '2026-10-15T12:00:00.000Z',
    '2026-10-15T12:00:00.001Z',
    '2026-10-15T12:00:00.999Z',
    '2026-10-15T12:00:01.000Z',
    '2026-10-15T12:00:01.001Z',
    '2026-10-15T11:59:59.999Z',
  ]) {
    const now = new Date(timestamp);
    expect(buildDashboard(data, query, now)).toEqual(buildDashboard(usage([...events]), query, now));
  }
  expect(at('2026-10-15T12:00:00.000Z').totals.tokens).toBe(100);
  expect(at('2026-10-15T12:00:00.000Z').previous?.tokens).toBe(100);
  expect(at('2026-10-15T12:00:00.001Z').totals.tokens).toBe(0);
  expect(at('2026-10-15T12:00:00.001Z').previous?.tokens).toBe(100);
  expect(at('2026-10-15T12:00:01.000Z').totals.tokens).toBe(100);

  const warnings = ['A fresh collector warning.'];
  const sources = [{ harness: 'codex' as const, path: '/fresh', files: 1, events: 3, status: 'ready' as const }];
  const updated = buildDashboard(
    { ...data, warnings, sources, pricingUpdatedAt: 'fresh-pricing' },
    query,
    new Date('2026-10-15T12:00:01.001Z'),
    'Renamed machine',
  );
  expect(updated).toMatchObject({ machine: 'Renamed machine', pricing: { updatedAt: 'fresh-pricing' } });
  expect(updated.warnings).toBe(warnings);
  expect(updated.sources).toBe(sources);
});

test('aggregate reuse preserves calendar transitions, clock changes, filters, and immutable pricing snapshots', () => {
  const events = [
    event({ timestamp: '2026-11-01T08:30:00.000Z' }),
    event({ id: 'second', timestamp: '2026-10-25T08:30:00.000Z', model: 'other-model' }),
    event({ id: 'third', timestamp: '2026-10-18T08:30:00.000Z', model: 'other-model' }),
  ];
  const data = usage(events);
  for (const range of ['today', '7d', '30d', '90d', '6m', 'all'] as const) {
    const query = { range, timezone: 'America/Los_Angeles' };
    for (const timestamp of [
      '2026-11-01T08:29:59.999Z',
      '2026-11-01T08:30:00.000Z',
      '2026-11-01T08:30:00.001Z',
      '2026-11-01T09:30:00.000Z',
      '2026-11-01T09:30:00.001Z',
      '2026-11-02T07:59:59.999Z',
      '2026-11-02T08:00:00.000Z',
      '2026-11-01T08:30:00.000Z',
    ]) {
      const now = new Date(timestamp);
      expect(buildDashboard(data, query, now)).toEqual(buildDashboard(usage([...events]), query, now));
    }
  }
  const now = new Date('2026-11-01T12:00:00.000Z');
  const query = { range: 'all' as const, models: ['other-model'] };
  const first = buildDashboard(data, query, now);
  expect(buildDashboard(data, query, now).sessions).toBe(first.sessions);
  query.models.length = 0;
  expect(buildDashboard(data, query, now).totals.tokens).toBe(0);
  const all = buildDashboard(data, { range: 'all' }, now);
  expect(buildDashboard(usage([...events]), { range: 'all' }, now).sessions).not.toBe(all.sessions);
  const policy = { catalog: { updatedAt: 'test', source: '', models: {} }, rules: [], revision: 'test' };
  expect(buildDashboard(data, { range: 'all' }, now, 'Test', policy).sessions).not.toBe(all.sessions);
  const invalidZone = buildDashboard(data, { range: 'all', timezone: 'unavailable/timezone' }, now);
  const freshWarnings = ['Fresh warning'];
  expect(
    buildDashboard({ ...data, warnings: freshWarnings }, { range: 'all', timezone: 'unavailable/timezone' }, now)
      .warnings,
  ).toEqual([...freshWarnings, ...invalidZone.warnings]);
});

test('the copied-ID index bootstraps existing owners and tracks corrections, withdrawals, updates, and rollbacks', async () => {
  const { directory, runtime } = await storeRuntime();
  const secondDevice = { ...remoteDevice, id: 'second-owner' };
  const thirdDevice = { ...remoteDevice, id: 'third-owner' };
  const filename = join(directory, 'usage.sqlite');
  const copied = () => {
    const database = new Database(filename, { readonly: true });
    try {
      return database.query('SELECT id FROM usage_copied_ids ORDER BY id').all();
    } finally {
      database.close();
    }
  };
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const first = yield* store.registerDevice(pairingSecret, remoteDevice);
      const second = yield* store.registerDevice(pairingSecret, secondDevice);
      const third = yield* store.registerDevice(pairingSecret, thirdDevice);
      const original = event();
      yield* store.syncUsage(remoteDevice.id, first.token, { device: remoteDevice, events: [original] });
      expect(copied()).toEqual([]);
      yield* store.syncUsage(secondDevice.id, second.token, { device: secondDevice, events: [original] });
      expect(copied()).toEqual([{ id: original.id }]);
      yield* store.syncUsage(thirdDevice.id, third.token, { device: thirdDevice, events: [original] });
      yield* store.syncUsage(secondDevice.id, second.token, {
        device: secondDevice,
        events: [],
        deletedIds: [original.id],
      });
      expect(copied()).toEqual([{ id: original.id }]);
      yield* store.syncUsage(thirdDevice.id, third.token, {
        device: thirdDevice,
        events: [],
        deletedIds: [original.id],
      });
      expect(copied()).toEqual([]);
      yield* store.syncUsage(remoteDevice.id, first.token, {
        device: remoteDevice,
        events: [{ ...original, inputTokens: 200 }],
      });
      expect(copied()).toEqual([]);
      yield* store.syncUsage(secondDevice.id, second.token, { device: secondDevice, events: [original] });
    }),
  );
  await runtime.dispose();
  const database = new Database(filename);
  try {
    database.exec(`DROP TRIGGER usage_copied_ids_insert;
      DROP TRIGGER usage_copied_ids_delete;
      DROP TRIGGER usage_copied_ids_update;
      DROP TABLE usage_copied_ids;`);
  } finally {
    database.close();
  }
  const reopened = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  try {
    expect((await reopened.runPromise(Effect.flatMap(UsageStore, (store) => store.getUsage()))).events).toHaveLength(2);
    expect(copied()).toEqual([{ id: 'performance-request' }]);
  } finally {
    await reopened.dispose();
  }
  const updated = new Database(filename);
  try {
    updated.exec('BEGIN');
    updated.query('UPDATE usage_events SET id = ? WHERE device_id = ?').run('renamed-request', secondDevice.id);
    expect(copied()).toEqual([{ id: 'performance-request' }]);
    expect(updated.query('SELECT id FROM usage_copied_ids').all()).toEqual([]);
    updated.query('UPDATE usage_events SET id = ? WHERE device_id = ?').run('performance-request', secondDevice.id);
    expect(updated.query('SELECT id FROM usage_copied_ids').all()).toEqual([{ id: 'performance-request' }]);
    updated.query('DELETE FROM usage_events WHERE device_id = ?').run(secondDevice.id);
    expect(updated.query('SELECT id FROM usage_copied_ids').all()).toEqual([]);
    updated.exec('ROLLBACK');
    expect(copied()).toEqual([{ id: 'performance-request' }]);
  } finally {
    updated.close();
  }
});
