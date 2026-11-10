import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { SqlClient, Statement } from 'effect/sql';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageStoreLayer } from '../../src/lib/server/rpc/server';
import { ServerConfiguration, UsageStore } from '../../src/lib/server/rpc/store';
import type { SourceStatus, UsageEvent } from '../../src/lib/shared/domain';

const directories: string[] = [];
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const pairingSecret = 'isolated-store-cache-test-secret';
const device = { id: 'cached-device', name: 'Laptop', platform: 'darwin' };
const event: UsageEvent = {
  id: 'cached-request',
  timestamp: '2026-10-03T01:00:00.000Z',
  harness: 'codex',
  model: 'cached-model',
  project: '/work/app',
  repository: null,
  sessionId: 'cached-session',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  costKnown: false,
};
const source: SourceStatus = { harness: 'codex', path: '/usage', files: 1, events: 1, status: 'ready' };
const window = { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' };
const storeRuntime = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-store-cache-'));
  directories.push(directory);
  const runtime = ManagedRuntime.make(
    usageStoreLayer({ dataDirectory: directory, pairingSecret }).pipe(Layer.provideMerge(TestClock.layer())),
  );
  disposers.push(() => runtime.dispose());
  return { directory, runtime };
};

test('metadata changes refresh diagnostics while identical heartbeats preserve event generations and arrays', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      expect(store.getRevision()).toBe(0);
      expect(store.getMetadataRevision()).toBe(0);
      yield* store.registerDevice(pairingSecret, device);
      expect(store.getRevision()).toBe(0);
      expect(store.getMetadataRevision()).toBe(1);
      const registration = yield* store.registerDevice(pairingSecret, device);
      expect(store.getMetadataRevision()).toBe(1);
      const acknowledgement = yield* store.syncUsage(device.id, registration.token, {
        device,
        events: [event],
        sources: [source],
        pricingUpdatedAt: 'first-pricing',
      });
      expect(Object.keys(acknowledgement).sort()).toEqual(['accepted', 'deleted', 'receivedAt', 'updated']);
      const original = yield* store.getUsage(undefined, window);
      const revision = store.getRevision();
      const metadataRevision = store.getMetadataRevision();
      yield* TestClock.adjust('6 minutes');
      yield* store.syncUsage(device.id, registration.token, {
        device,
        events: [],
        sources: [source],
        pricingUpdatedAt: 'first-pricing',
      });
      expect(store.getRevision()).toBe(revision);
      expect(store.getMetadataRevision()).toBe(metadataRevision);
      expect((yield* store.getDevices())[0]?.lastSeen).toEqual(expect.any(String));
      expect((yield* store.getUsage(undefined, window)).events).toBe(original.events);

      const updatedDevice = { ...device, name: 'Ignored collector rename', platform: 'linux' };
      yield* store.syncUsage(device.id, registration.token, {
        device: updatedDevice,
        events: [],
        sources: [{ ...source, path: '/changed', events: 0, status: 'error', error: 'Read failed.' }],
      });
      expect(store.getRevision()).toBe(revision);
      expect(store.getMetadataRevision()).toBe(metadataRevision + 1);
      const updated = yield* store.getUsage(undefined, window);
      expect(updated.events).toBe(original.events);
      expect(updated.pricingSnapshots).toBe(original.pricingSnapshots);
      expect(updated.sources).toEqual([
        { ...source, path: 'Laptop · /changed', events: 0, status: 'error', error: 'Read failed.' },
      ]);
      expect((yield* store.getDevices())[0]?.platform).toBe('linux');

      yield* store.syncUsage(device.id, registration.token, {
        device: updatedDevice,
        events: [],
        pricingUpdatedAt: 'second-pricing',
      });
      expect(store.getMetadataRevision()).toBe(metadataRevision + 2);
      const repriced = yield* store.getUsage(undefined, window);
      expect(repriced.events).toBe(original.events);
      expect(repriced.pricingSnapshots).toBe(original.pricingSnapshots);
      expect(repriced.pricingUpdatedAt).toBe('second-pricing');
      expect(repriced.sources).toEqual(updated.sources);

      yield* store.renameDevice(device.id, 'Work laptop');
      expect(store.getMetadataRevision()).toBe(metadataRevision + 3);
      yield* store.renameDevice(device.id, 'Work laptop');
      expect(store.getMetadataRevision()).toBe(metadataRevision + 3);
      expect(store.getRevision()).toBe(revision);
      const renamed = yield* store.getUsage(undefined, window);
      expect(renamed.events).toBe(original.events);
      expect(renamed.sources[0]?.path).toBe('Work laptop · /changed');

      // Reimporting an existing event fills nothing and does not evict windows.
      yield* store.importUsage(pairingSecret, { device: updatedDevice, events: [event] });
      expect(store.getRevision()).toBe(revision);
      expect(store.getMetadataRevision()).toBe(metadataRevision + 3);
      expect((yield* store.getUsage(undefined, window)).events).toBe(original.events);

      yield* store.syncUsage(device.id, registration.token, {
        device: updatedDevice,
        events: [{ ...event, inputTokens: 250 }],
      });
      expect(store.getRevision()).toBe(revision + 1);
      expect(store.getMetadataRevision()).toBe(metadataRevision + 3);
      const corrected = yield* store.getUsage(undefined, window);
      expect(corrected.events).not.toBe(original.events);
      expect(corrected.events[0]?.inputTokens).toBe(250);
      yield* store.syncUsage(device.id, registration.token, {
        device: updatedDevice,
        events: [],
        deletedIds: [event.id],
      });
      expect(store.getRevision()).toBe(revision + 2);
      const deleted = yield* store.getUsage(undefined, window);
      expect(deleted.events).toEqual([]);
      expect(deleted.pricingSnapshots).toEqual([]);
    }),
  );
});

test('two decoded windows retain arrays beyond the previous lifetime and evict the least recently used history', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, device);
      yield* store.syncUsage(device.id, registration.token, { device, events: [event] });
      const ranges = [{ start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' }, {}];
      const original = yield* Effect.forEach(ranges, (options) => store.getUsage(undefined, options));
      yield* TestClock.adjust('1 day');
      for (const [index, options] of ranges.entries()) {
        const cached = yield* store.getUsage(undefined, options);
        expect(cached.events).toBe(original[index].events);
        expect(cached.pricingSnapshots).toBe(original[index].pricingSnapshots);
      }
      yield* store.getUsage(undefined, ranges[0]);
      yield* store.getUsage(undefined, {
        start: '2026-10-02T00:00:00.000Z',
        end: '2026-10-04T00:00:00.000Z',
      });
      expect((yield* store.getUsage(undefined, ranges[0])).events).toBe(original[0].events);
      expect((yield* store.getUsage(undefined, ranges[1])).events).not.toBe(original[1].events);
      yield* store.syncUsage(device.id, registration.token, {
        device,
        events: [{ ...event, inputTokens: 300 }],
      });
      for (const [index, options] of ranges.entries()) {
        const corrected = yield* store.getUsage(undefined, options);
        expect(corrected.events).not.toBe(original[index].events);
        expect(corrected.events).toEqual(original[index].events.map((record) => ({ ...record, inputTokens: 300 })));
      }
    }),
  );
});

test('revocation and restoration refresh device settings while cached usage keeps its unchanged history', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, device);
      yield* store.syncUsage(device.id, registration.token, { device, events: [event], sources: [source] });
      const original = yield* store.getUsage(undefined, window);
      const dimensions = yield* store.getDimensions();
      const revision = store.getRevision();
      const metadataRevision = store.getMetadataRevision();

      yield* store.revokeDevice(device.id);
      expect((yield* store.getDevices())[0]).toMatchObject({
        revokedAt: expect.any(String),
        needsReconnect: true,
        eventCount: 1,
      });
      const revoked = yield* store.getUsage(undefined, window);
      expect(revoked.events).toBe(original.events);
      expect(revoked.sources).toEqual(original.sources);
      expect(yield* store.getDimensions()).toEqual(dimensions);

      yield* store.restoreDevice(device.id);
      expect((yield* store.getDevices())[0]).toMatchObject({ revokedAt: null, needsReconnect: true });
      expect((yield* store.getUsage(undefined, window)).events).toBe(original.events);
      yield* store.registerDevice(pairingSecret, device);
      expect((yield* store.getDevices())[0]).toMatchObject({ revokedAt: null, needsReconnect: false });
      expect((yield* store.getUsage(undefined, window)).events).toBe(original.events);
      expect(store.getRevision()).toBe(revision);
      expect(store.getMetadataRevision()).toBe(metadataRevision);
    }),
  );
});

test('failed batches roll back metadata, events, and both cache revisions before retrying', async () => {
  const { directory, runtime } = await storeRuntime();
  const store = await runtime.runPromise(UsageStore);
  const registration = await runtime.runPromise(store.registerDevice(pairingSecret, device));
  await runtime.runPromise(store.syncUsage(device.id, registration.token, { device, events: [event] }));
  const original = await runtime.runPromise(store.getUsage(undefined, window));
  const revision = store.getRevision();
  const metadataRevision = store.getMetadataRevision();
  const database = new Database(join(directory, 'usage.sqlite'));
  try {
    database.exec(`CREATE TRIGGER reject_test_metadata BEFORE UPDATE ON devices
      WHEN NEW.platform = 'rejected' BEGIN SELECT RAISE(ABORT, 'simulated metadata write failure'); END`);
    const batch = {
      device: { ...device, platform: 'rejected' },
      events: [{ ...event, inputTokens: 900 }],
      sources: [{ ...source, path: '/rejected' }],
      pricingUpdatedAt: 'rejected-pricing',
    };
    const failed = await runtime.runPromiseExit(store.syncUsage(device.id, registration.token, batch));
    expect(failed._tag).toBe('Failure');
    expect(store.getRevision()).toBe(revision);
    expect(store.getMetadataRevision()).toBe(metadataRevision);
    const afterFailure = await runtime.runPromise(store.getUsage(undefined, window));
    expect(afterFailure.events).toBe(original.events);
    expect(afterFailure.events[0]?.inputTokens).toBe(100);
    expect(afterFailure.sources).toEqual([]);
    expect(afterFailure.pricingUpdatedAt).toBe('');
    expect((await runtime.runPromise(store.getDevices()))[0]?.platform).toBe(device.platform);
    database.exec('DROP TRIGGER reject_test_metadata');
    expect(await runtime.runPromise(store.syncUsage(device.id, registration.token, batch))).toMatchObject({
      accepted: 0,
      updated: 1,
      deleted: 0,
    });
    expect(store.getRevision()).toBe(revision + 1);
    expect(store.getMetadataRevision()).toBe(metadataRevision + 1);
    const retried = await runtime.runPromise(store.getUsage(undefined, window));
    expect(retried.events[0]?.inputTokens).toBe(900);
    expect(retried.sources[0]?.path).toBe('Laptop · /rejected');
    expect(retried.pricingUpdatedAt).toBe('rejected-pricing');
  } finally {
    database.close();
  }
});

test('cancellation rolls back active writes but committed registration, sync, import, and rename publish generations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-store-cancellation-'));
  directories.push(directory);
  let checkpoint: 'during-body' | 'before-commit' | 'after-commit' | undefined;
  let interruptTransaction: (() => void) | undefined;
  let attemptedUpserts = 0;
  const interruptAt = (phase: typeof checkpoint) =>
    Effect.withFiber((fiber) =>
      Effect.sync(() => {
        if (checkpoint === phase) {
          checkpoint = undefined;
          fiber.interruptUnsafe();
        }
      }),
    );
  const controlledStore = Layer.effect(
    UsageStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const withTransaction = sql.withTransaction;
      const unsafe = sql.unsafe;
      // Use real SQLite transactions, requesting cancellation immediately
      // before or after the durable commit rather than relying on a timer.
      const controlledSql = Object.assign(sql, {
        unsafe: <A extends object>(query: string, parameters?: readonly unknown[]) => {
          if (checkpoint === 'during-body' && query.startsWith('INSERT INTO usage_events')) {
            attemptedUpserts++;
            if (attemptedUpserts === 2) {
              checkpoint = undefined;
              interruptTransaction?.();
            }
          }
          return unsafe<A>(query, parameters);
        },
        withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) =>
          Effect.withFiber((fiber) => {
            interruptTransaction = () => fiber.interruptUnsafe();
            return withTransaction(
              program.pipe(Effect.tap(() => interruptAt('before-commit').pipe(Effect.interruptible))),
            ).pipe(Effect.tap(() => interruptAt('after-commit')));
          }),
      });
      return yield* UsageStore.make.pipe(Effect.provideService(SqlClient.SqlClient, controlledSql));
    }),
  ).pipe(
    Layer.provide(SqliteClient.layer({ filename: join(directory, 'usage.sqlite') })),
    Layer.provide(Layer.succeed(ServerConfiguration, { pairingSecret })),
  );
  const runtime = ManagedRuntime.make(controlledStore);
  disposers.push(() => runtime.dispose());
  const store = await runtime.runPromise(UsageStore);
  const empty = await runtime.runPromise(store.getUsage(undefined, window));

  checkpoint = 'after-commit';
  expect((await runtime.runPromiseExit(store.registerDevice(pairingSecret, device)))._tag).toBe('Failure');
  expect(store.getMetadataRevision()).toBe(1);
  expect(store.getRevision()).toBe(0);
  expect(await runtime.runPromise(store.getDevices())).toHaveLength(1);
  const registration = await runtime.runPromise(store.registerDevice(pairingSecret, device));
  expect(store.getMetadataRevision()).toBe(1);

  const batch = { device, events: [event], sources: [source], pricingUpdatedAt: 'committed-pricing' };
  checkpoint = 'before-commit';
  expect((await runtime.runPromiseExit(store.syncUsage(device.id, registration.token, batch)))._tag).toBe('Failure');
  expect(store.getRevision()).toBe(0);
  expect(store.getMetadataRevision()).toBe(1);
  const rolledBack = await runtime.runPromise(store.getUsage(undefined, window));
  expect(rolledBack.events).toBe(empty.events);
  expect(rolledBack.sources).toEqual([]);
  expect(rolledBack.pricingUpdatedAt).toBe('');
  expect((await runtime.runPromise(store.getDevices()))[0]).toMatchObject({ eventCount: 0, lastSeen: null });

  checkpoint = 'during-body';
  const cancelledUpload = await runtime.runPromiseExit(
    store.syncUsage(device.id, registration.token, {
      ...batch,
      events: Array.from({ length: 32 }, (_, index) => ({ ...event, id: `cancelled-${index}` })),
    }),
  );
  expect(cancelledUpload._tag).toBe('Failure');
  expect(attemptedUpserts).toBe(2);
  expect(store.getRevision()).toBe(0);
  expect(store.getMetadataRevision()).toBe(1);
  expect((await runtime.runPromise(store.getUsage(undefined, window))).events).toBe(empty.events);
  expect((await runtime.runPromise(store.getDevices()))[0]).toMatchObject({ eventCount: 0, lastSeen: null });

  checkpoint = 'after-commit';
  expect((await runtime.runPromiseExit(store.syncUsage(device.id, registration.token, batch)))._tag).toBe('Failure');
  expect(store.getRevision()).toBe(1);
  expect(store.getMetadataRevision()).toBe(2);
  const committed = await runtime.runPromise(store.getUsage(undefined, window));
  expect(committed.events).not.toBe(empty.events);
  expect(committed.events[0]?.inputTokens).toBe(100);
  expect(committed.sources[0]?.path).toBe('Laptop · /usage');
  expect(committed.pricingUpdatedAt).toBe('committed-pricing');

  checkpoint = 'after-commit';
  expect((await runtime.runPromiseExit(store.renameDevice(device.id, 'Renamed laptop')))._tag).toBe('Failure');
  expect(store.getMetadataRevision()).toBe(3);
  const renamed = await runtime.runPromise(store.getUsage(undefined, window));
  expect(renamed.events).toBe(committed.events);
  expect(renamed.sources[0]?.path).toBe('Renamed laptop · /usage');

  const imported = { ...batch, device: { ...device, id: 'imported-device', name: 'Imported' } };
  checkpoint = 'before-commit';
  expect((await runtime.runPromiseExit(store.importUsage(pairingSecret, imported)))._tag).toBe('Failure');
  expect(store.getRevision()).toBe(1);
  expect(store.getMetadataRevision()).toBe(3);
  expect(await runtime.runPromise(store.getDevices())).toHaveLength(1);
  checkpoint = 'after-commit';
  expect((await runtime.runPromiseExit(store.importUsage(pairingSecret, imported)))._tag).toBe('Failure');
  expect(store.getRevision()).toBe(2);
  expect(store.getMetadataRevision()).toBe(4);
  const afterImport = await runtime.runPromise(store.getUsage(undefined, window));
  expect(afterImport.events).toHaveLength(2);
  expect(afterImport.sources.map((status) => status.path).sort()).toEqual([
    'Imported · /usage',
    'Renamed laptop · /usage',
  ]);
});

test('overlapping windows share historical pages while moves, deletions and backfills refresh the affected UTC days', async () => {
  const { runtime } = await storeRuntime();
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const registration = yield* store.registerDevice(pairingSecret, device);
      const write = (events: UsageEvent[], deletedIds?: string[]) =>
        store.syncUsage(device.id, registration.token, { device, events, deletedIds });
      const record = (id: string, timestamp: string): UsageEvent => ({ ...event, id, timestamp });
      // The first request is on October 1 in UTC, despite its October 2 wall date.
      const old = record('moves', '2026-10-02T00:30:00+02:00');
      const stable = record('stable', '2026-10-03T13:00:00Z');
      const today = record('deleted', '2026-10-04T13:00:00Z');
      yield* write([old, stable, today]);
      const all = yield* store.getUsage();
      const since = { start: '2026-10-02T07:00:00.000Z', devices: [device.id] };
      const subset = yield* store.getUsage(undefined, since);
      expect(subset.events.map((r) => r.id)).toEqual(['stable', 'deleted']);
      expect(subset.events[0]).toBe(all.events[1]);
      const moved = { ...old, timestamp: '2026-10-05T01:00:00Z' };
      const backfill = record('backfill', '2026-09-30T00:00:00Z');
      yield* write([moved, backfill], [today.id]);
      const changed = yield* store.getUsage();
      expect(changed.events.map((r) => [r.id, r.timestamp])).toEqual(
        [backfill, stable, moved].map((r) => [r.id, r.timestamp]),
      );
      expect(changed.events[1]).toBe(all.events[1]);
      const changedSubset = yield* store.getUsage(undefined, since);
      expect(changedSubset.events.map((r) => r.id)).toEqual(['stable', 'moves']);
      expect(changedSubset.events[0]).toBe(all.events[1]);
      expect((yield* store.getUsage(undefined, { ...since, devices: [] })).events).toEqual([]);
    }),
  );
});

test('a correction between pages or before the local-owner lookup cannot make an event disappear', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-page-race-'));
  directories.push(directory);
  let pause: ((sql: string, args: readonly unknown[]) => Promise<void> | undefined) | undefined;
  const transformer: Statement.Transformer = (statement) => {
    const gate = pause?.(...statement.compile());
    return gate
      ? Effect.as(
          Effect.promise(() => gate),
          statement,
        )
      : Effect.succeed(statement);
  };
  const hooks = Layer.succeed(Statement.CurrentTransformer, transformer);
  const runtime = ManagedRuntime.make(
    usageStoreLayer({ dataDirectory: directory, pairingSecret }).pipe(Layer.provideMerge(hooks)),
  );
  disposers.push(() => runtime.dispose());
  const store = await runtime.runPromise(UsageStore);
  const { token } = await runtime.runPromise(store.registerDevice(pairingSecret, device));
  const write = (...events: UsageEvent[]) => runtime.runPromise(store.syncUsage(device.id, token, { device, events }));
  const anchor = { ...event, id: 'anchor', timestamp: '2026-10-01T00:00:00Z' };
  let moved = { ...event, id: 'moving', timestamp: '2026-10-02T00:00:00Z' };
  const local = { ...event, id: 'local-candidate', timestamp: '2026-10-03T00:00:00Z' };
  await write(anchor, moved, local);
  const race = async (
    match: (sql: string, args: readonly unknown[]) => boolean,
    options: Parameters<typeof store.getUsage>[1],
    change: UsageEvent,
  ) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    pause = (sql, args) => {
      if (!match(sql, args)) return;
      pause = undefined;
      entered.resolve();
      return resume.promise;
    };
    const pending = runtime.runPromise(store.getUsage(undefined, options));
    try {
      await entered.promise;
      await write(change);
    } finally {
      resume.resolve();
    }
    return pending;
  };
  moved = { ...moved, timestamp: '2026-10-01T02:00:00Z' };
  const middle = await race(
    (sql, args) => sql.includes('INDEXED BY usage_events_timestamp') && args.includes('2026-10-02T'),
    {},
    moved,
  );
  expect(middle.events.map(({ id, timestamp }) => [id, timestamp])).toEqual(
    [anchor, moved, local].map(({ id, timestamp }) => [id, timestamp]),
  );
  const nowInside = { ...local, timestamp: '2026-10-01T03:00:00Z' };
  const supplemental = await race(
    (sql, args) => sql.includes('id IN (SELECT value FROM json_each(?)') && args.includes(JSON.stringify([local.id])),
    {
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-02T00:00:00.000Z',
      candidateIds: [local.id],
    },
    nowInside,
  );
  expect(supplemental.events.map(({ id, timestamp }) => [id, timestamp])).toEqual(
    [anchor, moved, nowInside].map(({ id, timestamp }) => [id, timestamp]),
  );
});

test('a busy writer cannot delay an optional day fill, and a narrower range clips indexed UTC times', async () => {
  const { directory, runtime } = await storeRuntime();
  await runtime.runPromise(TestClock.setTime(Date.parse('2026-10-05T12:00Z')));
  const store = await runtime.runPromise(UsageStore);
  const registration = await runtime.runPromise(store.registerDevice(pairingSecret, device));
  const times = ['2026-10-02T23:30:00-02:00', '2026-10-03T01:45:00Z', '2026-10-03T04:00:00+02:00'];
  await runtime.runPromise(
    store.syncUsage(device.id, registration.token, {
      device,
      events: times.map((timestamp, i) => ({ ...event, id: `edge-${i}`, timestamp })),
    }),
  );
  const writer = new Database(join(directory, 'usage.sqlite'));
  try {
    expect(writer.query("SELECT name FROM sqlite_master WHERE name = 'usage_day_packs_v1'").get()).not.toBeNull();
    writer.exec('BEGIN IMMEDIATE');
    const start = performance.now();
    const full = await runtime.runPromise(store.getUsage(undefined, window));
    expect(full.events.map((e) => e.id)).toEqual(['edge-0', 'edge-1', 'edge-2']);
    expect(performance.now() - start).toBeLessThan(2000); // The canonical writer timeout is 5s.
    expect(writer.query('SELECT day FROM usage_day_packs_v1').all()).toEqual([]);
    writer.exec('ROLLBACK');
    const partial = await runtime.runPromise(
      store.getUsage(undefined, {
        start: '2026-10-03T01:30:00.000Z',
        end: '2026-10-03T02:00:00.000Z',
        devices: [device.id],
      }),
    );
    expect(partial.events.map((e) => e.id)).toEqual(['edge-0', 'edge-1']);
    // Reuse the immutable parents, not a second SQL scan + decode.
    expect(partial.events[0]).toBe(full.events[0]);
    expect(partial.pricingSnapshots[1]).toBe(full.pricingSnapshots[1]);
  } finally {
    writer.close();
  }
});
