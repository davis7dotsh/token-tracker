import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, Exit, Layer, ManagedRuntime } from 'effect';
import { UsageStore } from '../../src/lib/server/rpc/store';
import { usageStoreLayer } from '../../src/lib/server/rpc/server';
import type { UsageEvent } from '../../src/lib/shared/domain';
import { changedRecords } from '../../src/cli/checkpoint';
import { appendCheckpoint, compactCheckpoint, readCheckpoint, type Connection } from '../../src/cli/state';
import { commitChangedBatches, commitRetractedBatches } from '../../src/cli/sync';

const device = { id: 'test-retraction', name: 'Retraction test', platform: 'linux' };
const event = (id: string): UsageEvent => ({
  id,
  timestamp: '2026-07-01T00:00:00Z',
  harness: 'codex',
  model: 'gpt-6.1-sol',
  project: '/work/app',
  repository: null,
  sessionId: 'session',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 20,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.001,
  costKnown: true,
});

test('proved replay deletions retry after server acknowledgement, survive torn journals, and preserve archived history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-retractions-'));
  const previous = process.env.TOKEN_TRACKER_CONFIG_DIR;
  process.env.TOKEN_TRACKER_CONFIG_DIR = join(directory, 'client');
  const secret = 'retraction-test-only-pairing-secret';
  const runtime = ManagedRuntime.make(
    Layer.merge(
      BunServices.layer,
      usageStoreLayer({ dataDirectory: join(directory, 'server'), pairingSecret: secret }),
    ),
  );
  try {
    const registration = await runtime.runPromise(
      Effect.flatMap(UsageStore, (store) => store.registerDevice(secret, device)),
    );
    const connection: Connection = {
      device,
      url: 'https://test.example',
      token: registration.token,
      intervalMinutes: 5,
      scheduler: null,
      connectedAt: '2026-10-05T00:00:00Z',
    };
    const upload = (events: readonly UsageEvent[], deletedIds: readonly string[] = []) =>
      Effect.flatMap(UsageStore, (store) =>
        store.syncUsage(device.id, registration.token, { device, events, deletedIds }),
      );
    const original = event('original');
    const replay = event('copied-prefix');
    const archived = event('archived-locally');
    const initial = await runtime.runPromise(readCheckpoint(connection));
    const imported = await runtime.runPromise(
      commitChangedBatches(
        initial,
        changedRecords([original, replay, archived], initial),
        upload,
        appendCheckpoint,
        compactCheckpoint,
      ),
    );
    // A parser-proved identity is eligible for withdrawal. An absent archived
    // source is intentionally not part of this list.
    const failed = await runtime.runPromiseExit(
      commitRetractedBatches(
        imported.checkpoint,
        [replay.id],
        (ids) => upload([], ids),
        () => Effect.fail('disk full'),
        compactCheckpoint,
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    const stale = await runtime.runPromise(readCheckpoint(connection));
    expect(Object.keys(stale.eventDigests).sort()).toEqual([archived.id, replay.id, original.id].sort());
    const retried = await runtime
      .runPromise(
        commitRetractedBatches(
          stale,
          [replay.id, replay.id, 'never-uploaded'],
          (ids) => upload([], ids),
          appendCheckpoint,
          () => Effect.fail('interrupted compact'),
        ),
      )
      .catch(() => null);
    expect(retried).toBeNull();
    const journalPath = join(directory, 'client', 'checkpoint-journal.jsonl');
    const journal = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, `${journal}{"deletedIds":[`);
    const recovered = await runtime.runPromise(readCheckpoint(connection));
    expect(Object.keys(recovered.eventDigests).sort()).toEqual([archived.id, original.id].sort());
    expect(recovered.deletedIds).toEqual([replay.id, 'never-uploaded']);
    // Appending after a killed write recovers without dropping later progress.
    await runtime.runPromise(appendCheckpoint({ ...recovered, eventDigests: { later: 'digest-later' } }));
    const restarted = await runtime.runPromise(readCheckpoint(connection));
    expect(restarted.eventDigests.later).toBe('digest-later');
    await runtime.runPromise(compactCheckpoint(restarted));
    const again = await runtime.runPromise(
      commitRetractedBatches(
        restarted,
        [replay.id],
        () => Effect.die('unexpected repeated deletion'),
        appendCheckpoint,
        compactCheckpoint,
      ),
    );
    expect(again.deleted).toBe(0);
    const stored = await runtime.runPromise(Effect.flatMap(UsageStore, (store) => store.getUsage()));
    expect(stored.events.map(({ id }) => id).sort()).toEqual([archived.id, original.id].sort());
    expect(changedRecords([original], restarted)).toEqual([]);
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.TOKEN_TRACKER_CONFIG_DIR;
    else process.env.TOKEN_TRACKER_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('large retractions preserve acknowledged batches and retry only the failed remainder', async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `replay-${index}`);
  const checkpoint = {
    version: 1 as const,
    remote: 'https://test.example',
    deviceId: device.id,
    syncedAt: null,
    eventDigests: Object.fromEntries(ids.map((id) => [id, 'old-digest'])),
  };
  let durable = structuredClone(checkpoint);
  const withdrawn = new Set<string>();
  let uploads = 0;
  const failed = await Effect.runPromiseExit(
    commitRetractedBatches(
      checkpoint,
      ids,
      (batch) =>
        ++uploads === 1
          ? Effect.succeed({ accepted: 0, updated: 0, deleted: batch.length, receivedAt: '2026-10-05T01:00:00Z' })
          : Effect.fail('offline'),
      (delta) =>
        Effect.sync(() => {
          for (const id of delta.deletedIds ?? []) {
            delete durable.eventDigests[id];
            withdrawn.add(id);
          }
        }),
      () => Effect.die('must not compact a failed run'),
    ),
  );
  expect(Exit.isFailure(failed)).toBe(true);
  expect(Object.keys(durable.eventDigests)).toEqual([ids[500]]);
  expect(Object.keys(checkpoint.eventDigests)).toHaveLength(501);
  const retried = await Effect.runPromise(
    commitRetractedBatches(
      { ...durable, deletedIds: [...withdrawn] },
      ids,
      (batch) =>
        Effect.sync(() => {
          expect(batch).toEqual([ids[500]]);
          return { accepted: 0, updated: 0, deleted: 1, receivedAt: '2026-10-05T01:01:00Z' };
        }),
      () => Effect.void,
      () => Effect.void,
    ),
  );
  expect(retried.checkpoint.eventDigests).toEqual({});
  expect(retried.deleted).toBe(1);
});

test('a lost checkpoint still cleans proven uploaded copies and a new original clears its withdrawal', async () => {
  const checkpoint = {
    version: 1 as const,
    remote: 'https://test.example',
    deviceId: device.id,
    syncedAt: null,
    eventDigests: {},
  };
  const fixed = await Effect.runPromise(
    commitRetractedBatches(
      checkpoint,
      ['legacy-copy'],
      (ids) =>
        Effect.sync(() => {
          expect(ids).toEqual(['legacy-copy']);
          return { accepted: 0, updated: 0, deleted: 1, receivedAt: '2026-10-05T01:00:00Z' };
        }),
      () => Effect.void,
      () => Effect.void,
    ),
  );
  expect(fixed.checkpoint.deletedIds).toEqual(['legacy-copy']);
  const original = event('legacy-copy');
  const uploaded = await Effect.runPromise(
    commitChangedBatches(
      fixed.checkpoint,
      changedRecords([original], fixed.checkpoint),
      () => Effect.succeed({ accepted: 1, updated: 0, deleted: 0, receivedAt: '2026-10-05T02:00:00Z' }),
      () => Effect.void,
      () => Effect.void,
    ),
  );
  expect(uploaded.checkpoint.deletedIds).toEqual([]);
  expect(changedRecords([original], uploaded.checkpoint)).toEqual([]);
});
