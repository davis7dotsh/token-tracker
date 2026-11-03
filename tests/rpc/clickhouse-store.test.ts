import { afterAll, expect, test } from 'bun:test';
import { Effect, ManagedRuntime } from 'effect';
import { randomBytes } from 'node:crypto';
import { makeClickHouseClient } from '../../src/lib/server/rpc/clickhouse';
import { clickHouseUsageStoreLayer } from '../../src/lib/server/rpc/clickhouse-store';
import { UsageStore } from '../../src/lib/server/rpc/store';
import type { UsageEvent } from '../../src/lib/shared/domain';

// Runs against a live server only, e.g. after `bun run ch:up`:
//   CLICKHOUSE_TEST_URL=http://localhost:8123 CLICKHOUSE_USERNAME=token_tracker \
//   CLICKHOUSE_PASSWORD=token_tracker_dev bun test tests/rpc/clickhouse-store.test.ts
const url = process.env.CLICKHOUSE_TEST_URL;
const run = url ? test : test.skip;
const config = {
  url: url ?? '',
  database: `token_tracker_test_${randomBytes(4).toString('hex')}`,
  username: process.env.CLICKHOUSE_USERNAME ?? 'token_tracker',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
};
const pairingSecret = 'test-pairing-secret-long-enough';
const device = { id: 'test-laptop', name: 'Laptop', platform: 'darwin' };
const day = (date: string) => ({ start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` });
const event: UsageEvent = {
  // Quotes and backslashes exercise query parameter escaping.
  id: "request-'1'\\",
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

afterAll(async () => {
  if (url)
    await makeClickHouseClient(config).command(`DROP DATABASE IF EXISTS ${config.database}`, { database: 'default' });
});

run('ClickHouse store syncs, corrects, deletes, and revokes like SQLite', async () => {
  const runtime = ManagedRuntime.make(clickHouseUsageStoreLayer(config, pairingSecret));
  const store = <A, E>(use: (store: UsageStore['Service']) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(UsageStore, use));
  try {
    const { token } = await store((usage) => usage.registerDevice(pairingSecret, device));
    const upload = (events: readonly UsageEvent[], deletedIds: readonly string[] = []) =>
      store((usage) => usage.syncUsage(device.id, token, { device, events, deletedIds }));
    const windowEvents = async (date: string) => (await store((usage) => usage.getUsage(undefined, day(date)))).events;
    const routed = { ...event, rawModel: 'anthropic/claude-sonnet-4-6' };
    expect(await upload([routed])).toMatchObject({ accepted: 1, updated: 0, deleted: 0 });
    expect(await upload([routed])).toMatchObject({ accepted: 0, updated: 0, deleted: 0 });
    // A correction that drops an optional field clears it.
    expect(await upload([{ ...event, outputTokens: 75 }])).toMatchObject({ accepted: 0, updated: 1 });

    const all = await store((usage) => usage.getUsage());
    expect(all.events).toEqual([{ ...event, outputTokens: 75, deviceId: device.id }]);
    expect(all.events[0]).not.toHaveProperty('rawModel');
    expect(await windowEvents('2026-10-03')).toHaveLength(1);
    expect(await store((usage) => usage.getDimensions())).toEqual([
      { deviceId: device.id, harness: 'claude', model: event.model, project: 'github.com/ben/app' },
    ]);

    // A correction can move a record to another window; its offset survives verbatim.
    const moved = { ...event, outputTokens: 75, timestamp: '2026-10-05T03:00:00.000+02:00' };
    expect(await upload([moved])).toMatchObject({ updated: 1 });
    expect(await windowEvents('2026-10-03')).toEqual([]);
    expect(await windowEvents('2026-10-05')).toEqual([{ ...moved, deviceId: device.id }]);

    expect(await upload([], [event.id, event.id])).toMatchObject({ deleted: 1 });
    expect(await upload([], [event.id])).toMatchObject({ deleted: 0 });
    expect((await store((usage) => usage.getUsage())).events).toEqual([]);
    expect((await store((usage) => usage.getDevices()))[0]).toMatchObject({ id: device.id, eventCount: 0 });

    await store((usage) => usage.revokeDevice(device.id));
    const stale = await runtime.runPromiseExit(
      Effect.flatMap(UsageStore, (usage) => usage.authorizeDevice(device.id, token)),
    );
    expect(stale._tag).toBe('Failure');
    expect(
      (
        await runtime.runPromiseExit(
          Effect.flatMap(UsageStore, (usage) => usage.syncUsage(device.id, token, { device, events: [event] })),
        )
      )._tag,
    ).toBe('Failure');
    expect((await store((usage) => usage.getDevices()))[0]).toMatchObject({ needsReconnect: true });
    await store((usage) => usage.restoreDevice(device.id));
    const restored = await store((usage) => usage.registerDevice(pairingSecret, device));
    expect(restored.device).toMatchObject({ revokedAt: null, needsReconnect: false });
    expect(
      await store((usage) => usage.syncUsage(device.id, restored.token, { device, events: [event] })),
    ).toMatchObject({ accepted: 1 });

    // Another device's copy outside the window is still its owner, as in SQLite.
    const desktop = { id: 'test-desktop', name: 'Desktop', platform: 'linux' };
    const copy = await store((usage) => usage.registerDevice(pairingSecret, desktop));
    const outside = { ...event, timestamp: '2026-09-01T00:00:00.000Z' };
    await store((usage) => usage.syncUsage(desktop.id, copy.token, { device: desktop, events: [outside] }));
    expect(await windowEvents('2026-10-03')).toEqual([
      { ...outside, deviceId: desktop.id },
      { ...event, deviceId: device.id },
    ]);
    const remote = (candidateIds?: readonly string[]) =>
      store((usage) => usage.getUsage(device.id, { ...day('2026-10-03'), candidateIds }));
    expect((await remote()).events).toEqual([]);
    expect((await remote([event.id])).events).toEqual([{ ...outside, deviceId: desktop.id }]);
  } finally {
    await runtime.dispose();
  }
});
