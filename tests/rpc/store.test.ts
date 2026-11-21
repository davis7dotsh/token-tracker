import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect, ManagedRuntime } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../../src/lib/server/rpc/store';
import { usageStoreLayer } from '../../src/lib/server/rpc/server';
import type { UsageEvent } from '../../src/lib/shared/domain';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const event: UsageEvent = {
  id: 'request-1',
  timestamp: '2026-10-03T01:00:00.000Z',
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  project: '/work/app',
  repository: 'github.com/ben/app',
  sessionId: 'session-1',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.01,
  costKnown: true,
};
const device = { id: 'test-laptop', name: 'Laptop', platform: 'darwin' };
const pairingSecret = 'test-pairing-secret-long-enough';

test('atomic sync is idempotent, updates corrections, isolates device IDs, and survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-'));
  directories.push(directory);
  const options = { dataDirectory: directory, pairingSecret };
  const runtime = ManagedRuntime.make(usageStoreLayer(options));
  try {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageStore, (store) => store.registerDevice(pairingSecret, device)),
    );
    const upload = (events: readonly UsageEvent[], deletedIds: readonly string[] = []) =>
      runtime.runPromise(
        Effect.flatMap(UsageStore, (store) =>
          store.syncUsage(device.id, registration.token, { device, events, deletedIds }),
        ),
      );
    expect(await upload([event])).toMatchObject({ accepted: 1, updated: 0, deleted: 0 });
    expect(await upload([event])).toMatchObject({ accepted: 0, updated: 0, deleted: 0 });
    expect(await upload([{ ...event, outputTokens: 75 }])).toMatchObject({ accepted: 0, updated: 1 });

    const invalid = await runtime.runPromiseExit(
      Effect.flatMap(UsageStore, (store) =>
        store.syncUsage(device.id, registration.token, {
          device,
          events: [
            { ...event, id: 'request-2' },
            { ...event, id: 'invalid', inputTokens: -1 },
          ],
        }),
      ),
    );
    expect(invalid._tag).toBe('Failure');
    const data = await runtime.runPromise(Effect.flatMap(UsageStore, (store) => store.getUsage()));
    expect(data.events).toHaveLength(1);
    expect(data.events[0]).toMatchObject({ outputTokens: 75, deviceId: device.id });

    const secondDevice = { ...device, id: 'other-laptop' };
    const second = await runtime.runPromise(
      Effect.flatMap(UsageStore, (store) => store.registerDevice(pairingSecret, secondDevice)),
    );
    await runtime.runPromise(
      Effect.flatMap(UsageStore, (store) =>
        store.syncUsage(secondDevice.id, second.token, { device: secondDevice, events: [event] }),
      ),
    );
    expect((await runtime.runPromise(Effect.flatMap(UsageStore, (store) => store.getUsage()))).events).toHaveLength(2);
    expect(await upload([], [event.id])).toMatchObject({ accepted: 0, updated: 0, deleted: 1 });
  } finally {
    await runtime.dispose();
  }

  const reopened = ManagedRuntime.make(usageStoreLayer(options));
  try {
    const devices = await reopened.runPromise(Effect.flatMap(UsageStore, (store) => store.getDevices()));
    expect(devices.find((item) => item.id === 'other-laptop')?.eventCount).toBe(1);
    expect(devices.find((item) => item.id === device.id)?.eventCount).toBe(0);
  } finally {
    await reopened.dispose();
  }
});

test('pairing and uploads require credentials, and a device cannot upload as another device', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-auth-'));
  directories.push(directory);
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  try {
    const badPairing = await runtime.runPromiseExit(
      Effect.flatMap(UsageStore, (store) => store.registerDevice('wrong-secret', device)),
    );
    expect(badPairing._tag).toBe('Failure');
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageStore, (store) => store.registerDevice(pairingSecret, device)),
    );
    const badUpload = await runtime.runPromiseExit(
      Effect.flatMap(UsageStore, (store) => store.syncUsage(device.id, 'wrong-token', { device, events: [event] })),
    );
    expect(badUpload._tag).toBe('Failure');
    const mismatchedDevice = await runtime.runPromiseExit(
      Effect.flatMap(UsageStore, (store) =>
        store.syncUsage(device.id, registration.token, {
          device: { ...device, id: 'some-other-device' },
          events: [event],
        }),
      ),
    );
    expect(mismatchedDevice._tag).toBe('Failure');
    expect(await runtime.runPromise(Effect.flatMap(UsageStore, (store) => store.getUsage()))).toMatchObject({
      events: [],
    });
  } finally {
    await runtime.dispose();
  }
});

test('dashboard renames survive uploads, and revoked devices keep history but cannot upload or pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-devices-'));
  directories.push(directory);
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  const run = <A, E>(program: (store: UsageStore['Service']) => Effect.Effect<A, E>) =>
    runtime.runPromise(UsageStore.use(program));
  const failure = async <A, E>(program: (store: UsageStore['Service']) => Effect.Effect<A, E>) => {
    const exit = await runtime.runPromiseExit(UsageStore.use(program));
    return exit._tag === 'Failure' ? JSON.stringify(exit.cause) : 'succeeded';
  };
  try {
    const { token } = await run((store) => store.registerDevice(pairingSecret, device));
    expect(await run((store) => store.renameDevice(device.id, '  Work laptop  '))).toMatchObject({
      name: 'Work laptop',
      revokedAt: null,
    });
    expect(await failure((store) => store.renameDevice(device.id, ' '))).toContain('InvalidRequest');
    await run((store) => store.syncUsage(device.id, token, { device, events: [event] }));
    expect((await run((store) => store.getDevices()))[0]).toMatchObject({ name: 'Work laptop', eventCount: 1 });

    const revoked = await run((store) => store.revokeDevice(device.id));
    expect(revoked.revokedAt).toEqual(expect.any(String));
    expect(await failure((store) => store.syncUsage(device.id, token, { device, events: [event] }))).toContain(
      'revoked',
    );
    expect(await failure((store) => store.syncUsage(device.id, '', { device, events: [event] }))).toContain(
      'Unauthorized',
    );
    expect(await failure((store) => store.authorizeDevice(device.id, token))).toContain('Unauthorized');
    expect(
      await failure((store) =>
        store.importUsage(pairingSecret, { device, events: [{ ...event, id: 'imported-request' }] }),
      ),
    ).toContain('revoked');
    expect(await failure((store) => store.renameDevice(device.id, 'Old laptop'))).toContain('InvalidRequest');
    expect(await failure((store) => store.revokeDevice('missing-device'))).toContain('InvalidRequest');
    expect((await run((store) => store.getUsage())).events).toHaveLength(1);
    expect((await run((store) => store.getDevices()))[0]).toMatchObject({
      name: 'Work laptop',
      eventCount: 1,
      revokedAt: revoked.revokedAt,
    });

    // The pairing secret cannot bring a revoked device back.
    expect(await failure((store) => store.registerDevice(pairingSecret, device))).toContain('revoked');
    expect((await run((store) => store.getDevices()))[0]).toMatchObject({
      revokedAt: revoked.revokedAt,
      needsReconnect: true,
    });

    // Restoring lifts the block without reviving the discarded token.
    const restored = await run((store) => store.restoreDevice(device.id));
    expect(restored).toMatchObject({ name: 'Work laptop', revokedAt: null, needsReconnect: true });
    expect(await run((store) => store.restoreDevice(device.id))).toMatchObject({ revokedAt: null });
    expect(await failure((store) => store.restoreDevice('missing-device'))).toContain('InvalidRequest');
    expect(await failure((store) => store.syncUsage(device.id, token, { device, events: [event] }))).toContain(
      'Unauthorized',
    );
    expect(await failure((store) => store.authorizeDevice(device.id, token))).toContain('Unauthorized');

    const reconnected = await run((store) => store.registerDevice(pairingSecret, device));
    expect(reconnected.device).toMatchObject({ revokedAt: null, needsReconnect: false });
    expect(reconnected.token).not.toBe(token);
    expect(
      await run((store) => store.syncUsage(device.id, reconnected.token, { device, events: [event] })),
    ).toMatchObject({ accepted: 0 });
    expect(await failure((store) => store.syncUsage(device.id, token, { device, events: [event] }))).toContain(
      'Unauthorized',
    );
  } finally {
    await runtime.dispose();
  }
});

test('hubs created before collector versions gain the column and keep their devices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-collector-column-'));
  directories.push(directory);
  const database = new Database(join(directory, 'usage.sqlite'));
  database.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
    token_hash TEXT NOT NULL, last_seen TEXT, sources TEXT NOT NULL DEFAULT '[]',
    pricing_updated_at TEXT NOT NULL DEFAULT '', revoked_at TEXT)`);
  database
    .query('INSERT INTO devices (id, name, platform, token_hash, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(device.id, device.name, device.platform, 'existing-credential-hash', '2026-10-01T00:00:00.000Z');
  database.close();
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  const run = <A, E>(program: (store: UsageStore['Service']) => Effect.Effect<A, E>) =>
    runtime.runPromise(UsageStore.use(program));
  try {
    const [existing] = await run((store) => store.getDevices());
    expect(existing).toMatchObject({ id: device.id, lastSeen: '2026-10-01T00:00:00.000Z' });
    expect(existing).not.toHaveProperty('collectorVersion');
    const { token } = await run((store) => store.registerDevice(pairingSecret, device));
    await run((store) =>
      store.syncUsage(device.id, token, { device: { ...device, collectorVersion: ' 0.4.1+0cebd19 ' }, events: [] }),
    );
    expect((await run((store) => store.getDevices()))[0]?.collectorVersion).toBe('0.4.1+0cebd19');
    // Re-pairing from an older collector keeps the last reported build.
    await run((store) => store.registerDevice(pairingSecret, device));
    expect((await run((store) => store.getDevices()))[0]?.collectorVersion).toBe('0.4.1+0cebd19');
  } finally {
    await runtime.dispose();
  }
});

test('trace records replay without changes, move between machines, withdraw, and own usage from the cutover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-rpc-traces-'));
  directories.push(directory);
  const cutoff = '2026-10-03T00:00:00.000Z';
  // Pre-seed a collector row at/after the cutover before enabling trace mode:
  // it stays on disk for rollback, but trace-mode reads must not double-count it.
  const preRuntime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }));
  try {
    const { token: preToken } = await preRuntime.runPromise(
      UsageStore.use((store) => store.registerDevice(pairingSecret, device)),
    );
    await preRuntime.runPromise(
      UsageStore.use((store) =>
        store.syncUsage(device.id, preToken, { device, events: [{ ...event, id: 'pre-existing-after-cutoff' }] }),
      ),
    );
  } finally {
    await preRuntime.dispose();
  }
  const runtime = ManagedRuntime.make(usageStoreLayer({ dataDirectory: directory, pairingSecret }, cutoff));
  const run = <A, E>(program: (store: UsageStore['Service']) => Effect.Effect<A, E>) =>
    runtime.runPromise(UsageStore.use(program));
  const trace = { ...event, id: 'trace:usage-1', sessionTitle: 'Fix the build' };
  const siva = { id: 'trace:siva', name: 'siva', platform: 'linux' };
  try {
    expect(await run((store) => store.ingestTraces({ device: siva, events: [trace] }))).toMatchObject({ accepted: 1 });
    const revision = await run((store) => Effect.sync(store.getRevision));
    // A re-pull of unchanged rows writes nothing and keeps every cache.
    expect(await run((store) => store.ingestTraces({ device: siva, events: [trace] }))).toMatchObject({
      accepted: 0,
      updated: 0,
      deleted: 0,
    });
    expect(await run((store) => Effect.sync(store.getRevision))).toBe(revision);
    // A trace write stales only windows containing its days; collector writes stale all.
    const week = ['2026-10-03T00:00:00.000Z', '2026-10-10T00:00:00.000Z'] as const;
    const windowRevision = () => run((store) => Effect.sync(() => store.getRevision(...week)));
    const before = await windowRevision();
    await run((store) =>
      store.ingestTraces({
        device: siva,
        events: [{ ...trace, id: 'trace:old', timestamp: '2026-09-01T00:00:00.000Z' }],
      }),
    );
    expect(await windowRevision()).toBe(before);
    expect(await run((store) => Effect.sync(() => store.getRevision()))).toBeGreaterThan(revision);
    expect(await run((store) => store.withdrawTraces(['trace:old']))).toBe(1);
    // Late metadata without a title keeps the stored one.
    const { sessionTitle: _title, ...untitled } = trace;
    expect(
      await run((store) => store.ingestTraces({ device: siva, events: [{ ...untitled, project: '/w' }] })),
    ).toMatchObject({
      updated: 1,
    });
    // A corrected machine moves the record instead of counting it twice.
    const europa = { id: 'trace:europa', name: 'europa', platform: 'linux' };
    expect(await run((store) => store.ingestTraces({ device: europa, events: [trace] }))).toMatchObject({
      accepted: 1,
      deleted: 1,
    });
    const stored = (await run((store) => store.getUsage())).events;
    expect(stored.map((item) => [item.deviceId, item.sessionTitle])).toEqual([['trace:europa', 'Fix the build']]);
    expect(await run((store) => store.withdrawTraces(['trace:usage-1', 'request-1']))).toBe(1);
    expect((await run((store) => store.getUsage())).events).toEqual([]);
    // The trace source only writes trace records.
    const exit = await runtime.runPromiseExit(
      UsageStore.use((store) => store.ingestTraces({ device: siva, events: [event] })),
    );
    expect(exit._tag).toBe('Failure');
    // Collector uploads still succeed, but usage from the cutover on is the traces'.
    const { token } = await run((store) => store.registerDevice(pairingSecret, device));
    await run((store) =>
      store.syncUsage(device.id, token, {
        device,
        events: [
          { ...event, timestamp: '2026-10-02T23:59:59.999Z' },
          { ...event, id: 'late' },
        ],
      }),
    );
    expect((await run((store) => store.getUsage())).events.map((item) => item.id)).toEqual(['request-1']);
    expect(await run((store) => Effect.sync(() => store.getRevision(...week)))).toBe(
      await run((store) => Effect.sync(() => store.getSharedRevision())),
    );
  } finally {
    await runtime.dispose();
  }
});
