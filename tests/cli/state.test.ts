import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import {
  appendCheckpoint,
  compactCheckpoint,
  readCheckpoint,
  writePrivateJson,
  type Checkpoint,
  type Connection,
} from '../../src/cli/state';

const connection: Connection = {
  url: 'https://dashboard.example',
  token: 'test-only-token',
  device: { id: 'test-machine', name: 'Test', platform: 'linux' },
  intervalMinutes: 5,
  scheduler: null,
  connectedAt: '2026-10-01T00:00:00Z',
};
const empty: Checkpoint = {
  version: 1,
  remote: connection.url,
  deviceId: connection.device.id,
  syncedAt: null,
  eventDigests: {},
};

test('checkpoint restart merges acknowledged deltas, ignores foreign/incomplete records, and atomically compacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-checkpoint-journal-'));
  const previous = process.env.TOKEN_TRACKER_CONFIG_DIR;
  process.env.TOKEN_TRACKER_CONFIG_DIR = directory;
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
  try {
    await run(writePrivateJson('checkpoint.json', empty));
    const acknowledged: Checkpoint = {
      ...empty,
      syncedAt: '2026-10-03T01:00:00Z',
      eventDigests: { first: 'digest-first' },
    };
    await run(appendCheckpoint(acknowledged));
    expect((await stat(join(directory, 'checkpoint-journal.jsonl'))).mode & 0o777).toBe(0o600);
    await run(
      appendCheckpoint({ ...acknowledged, deviceId: 'foreign-machine', eventDigests: { foreign: 'digest-foreign' } }),
    );
    const journal = await readFile(join(directory, 'checkpoint-journal.jsonl'), 'utf8');
    await writeFile(join(directory, 'checkpoint-journal.jsonl'), `${journal}{"unfinished":`);
    expect(await run(readCheckpoint(connection))).toEqual(acknowledged);
    // New appends delimit a torn prior write, preserving this acknowledgement.
    await run(
      appendCheckpoint({
        ...acknowledged,
        syncedAt: '2026-10-03T02:00:00Z',
        eventDigests: { second: 'digest-second' },
      }),
    );
    const recovered = await run(readCheckpoint(connection));
    expect(recovered.eventDigests).toEqual({ first: 'digest-first', second: 'digest-second' });
    expect(recovered.syncedAt).toBe('2026-10-03T02:00:00Z');
    await run(compactCheckpoint(recovered));
    expect(await run(readCheckpoint(connection))).toEqual(recovered);
    expect(await Bun.file(join(directory, 'checkpoint-journal.jsonl')).exists()).toBe(false);
    expect((await stat(join(directory, 'checkpoint.json'))).mode & 0o777).toBe(0o600);
    const snapshot = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
    expect(snapshot.eventDigests).toEqual(recovered.eventDigests);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_TRACKER_CONFIG_DIR;
    else process.env.TOKEN_TRACKER_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
