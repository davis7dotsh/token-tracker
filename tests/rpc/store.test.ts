import { afterEach, expect, test } from 'bun:test';
import { Effect, ManagedRuntime } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, usageStoreLayer } from '../../src/lib/server/rpc/store';
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
