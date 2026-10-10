import { join } from 'node:path';
import { Console, Effect, Schedule } from 'effect';
import { UsageClient, rpcClientLayer } from '../lib/client/rpc';
import type { SyncAck, UsageEvent } from '../lib/shared/domain';
import { collectUsage } from '../lib/server/usage';
import { installPricingPolicy, loadPricing } from '../lib/server/usage/pricing-runtime';
import { acknowledgeEvents, batchesOf, changedRecords } from './checkpoint';
import {
  CliFailure,
  type Checkpoint,
  appendCheckpoint,
  compactCheckpoint,
  compactCheckpointIfLarge,
  configDirectory,
  readCheckpoint,
  readConnection,
  syncLock,
} from './state';

export const commitBatch = <E, R, E2, R2>(
  checkpoint: Checkpoint,
  events: readonly UsageEvent[],
  upload: Effect.Effect<SyncAck, E, R>,
  persist: (checkpoint: Checkpoint) => Effect.Effect<void, E2, R2>,
) =>
  Effect.gen(function* () {
    const acknowledgement = yield* upload;
    const updated = acknowledgeEvents(checkpoint, events, acknowledgement.receivedAt);
    yield* persist(updated);
    return { checkpoint: updated, acknowledgement };
  });

// A batch is durably journaled before advancing the in-memory checkpoint.
// Full history is serialized once on successful completion, not once per batch.
export const commitChangedBatches = <E, R, E2, R2, E3, R3>(
  checkpoint: Checkpoint,
  changed: ReturnType<typeof changedRecords>,
  upload: (events: readonly UsageEvent[]) => Effect.Effect<SyncAck, E, R>,
  persistDelta: (delta: Checkpoint) => Effect.Effect<void, E2, R2>,
  compact: (checkpoint: Checkpoint) => Effect.Effect<void, E3, R3>,
) =>
  Effect.gen(function* () {
    const digests = changed.length ? { ...checkpoint.eventDigests } : checkpoint.eventDigests;
    const deletedIds = new Set(checkpoint.deletedIds ?? []);
    let current = checkpoint;
    let accepted = 0;
    let updated = 0;
    const batches = changed.length ? batchesOf(changed) : [[]];
    for (const records of batches) {
      const acknowledgement = yield* upload(records.map((record) => record.event));
      const delta: Checkpoint = {
        version: 1,
        remote: checkpoint.remote,
        deviceId: checkpoint.deviceId,
        syncedAt: acknowledgement.receivedAt,
        eventDigests: Object.fromEntries(records.map((record) => [record.event.id, record.digest])),
      };
      yield* persistDelta(delta);
      Object.assign(digests, delta.eventDigests);
      for (const record of records) deletedIds.delete(record.event.id);
      current = { ...checkpoint, eventDigests: digests, syncedAt: acknowledgement.receivedAt };
      accepted += acknowledgement.accepted;
      updated += acknowledgement.updated;
    }
    if (checkpoint.deletedIds && changed.length) current = { ...current, deletedIds: [...deletedIds] };
    if (changed.length || checkpoint.syncedAt === null) yield* compact(current);
    return { checkpoint: current, accepted, updated };
  });

// Parser corrections prove inherited identities independently of checkpoints.
// Keep acknowledged withdrawals so repeated scans are cheap, while checkpoint
// loss still repairs the hub. Missing local logs never imply deletion.
export const commitRetractedBatches = <E, R, E2, R2, E3, R3>(
  checkpoint: Checkpoint,
  retractedIds: readonly string[],
  upload: (ids: readonly string[]) => Effect.Effect<SyncAck, E, R>,
  persistDelta: (delta: Checkpoint) => Effect.Effect<void, E2, R2>,
  compact: (checkpoint: Checkpoint) => Effect.Effect<void, E3, R3>,
) =>
  Effect.gen(function* () {
    const withdrawn = new Set(checkpoint.deletedIds ?? []);
    const ids = [...new Set(retractedIds)].filter((id) => !withdrawn.has(id));
    if (!ids.length) return { checkpoint, deleted: 0 };
    const digests = { ...checkpoint.eventDigests };
    let current = checkpoint;
    let deleted = 0;
    for (const batch of batchesOf(ids)) {
      const acknowledgement = yield* upload(batch);
      yield* persistDelta({
        version: 1,
        remote: checkpoint.remote,
        deviceId: checkpoint.deviceId,
        syncedAt: acknowledgement.receivedAt,
        eventDigests: {},
        deletedIds: batch,
      });
      for (const id of batch) {
        delete digests[id];
        withdrawn.add(id);
      }
      current = { ...checkpoint, eventDigests: digests, syncedAt: acknowledgement.receivedAt };
      deleted += acknowledgement.deleted;
    }
    current = { ...current, deletedIds: [...withdrawn] };
    yield* compact(current);
    return { checkpoint: current, deleted };
  });

const syncOnceProgram = Effect.fn('cli.syncOnce')(function* (quiet: boolean) {
  const connection = yield* readConnection();
  if (!connection)
    return yield* Effect.fail(
      new CliFailure({ message: 'No remote configured. Run token-tracker connect <url> first.' }),
    );
  yield* syncLock;
  const synchronized = yield* Effect.gen(function* () {
    const client = yield* UsageClient;
    const localPricing = yield* loadPricing();
    const centralPolicy = yield* client
      .GetPricingPolicy({
        revision: localPricing.policy.revision,
        deviceId: connection.device.id,
        token: connection.token,
      })
      .pipe(Effect.timeout('30 seconds'));
    const pricing = centralPolicy
      ? yield* installPricingPolicy(centralPolicy, undefined, localPricing.policy.revision)
      : localPricing;
    // Refresh before collection, so names, accounting, and the fingerprints
    // uploaded to the server describe the same central policy. Manual checks
    // only read this cache and never fetch or change pricing themselves.
    const data = yield* collectUsage({
      deviceId: connection.device.id,
      pricingPolicy: pricing.policy,
      cacheDirectory: join(configDirectory(), 'collection-cache'),
    });
    const checkpoint = yield* readCheckpoint(connection);
    const changed = changedRecords(data.events, checkpoint);
    // Empty batches still update heartbeat/source diagnostics on the dashboard.
    const result = yield* commitChangedBatches(
      checkpoint,
      changed,
      (events) =>
        client
          .SyncUsage({
            deviceId: connection.device.id,
            token: connection.token,
            batch: {
              device: connection.device,
              events,
              sources: data.sources,
              pricingUpdatedAt: data.pricingUpdatedAt,
            },
          })
          .pipe(Effect.timeout('30 seconds')),
      appendCheckpoint,
      compactCheckpoint,
    );
    const retractions = yield* commitRetractedBatches(
      result.checkpoint,
      data.retractedIds ?? [],
      (deletedIds) =>
        client
          .SyncUsage({
            deviceId: connection.device.id,
            token: connection.token,
            batch: {
              device: connection.device,
              events: [],
              deletedIds,
            },
          })
          .pipe(Effect.timeout('30 seconds')),
      appendCheckpoint,
      compactCheckpoint,
    );
    if (!changed.length) yield* compactCheckpointIfLarge(retractions.checkpoint);
    return {
      changed: changed.length,
      accepted: result.accepted,
      updated: result.updated,
      deleted: retractions.deleted,
      syncedAt: retractions.checkpoint.syncedAt,
    };
  }).pipe(
    Effect.timeout('10 minutes'),
    Effect.provide(rpcClientLayer(new URL('rpc', `${connection.url}/`).href)),
    Effect.mapError(
      (error) =>
        new CliFailure({
          message: `Sync failed; unacknowledged records will retry on the next run. ${'message' in error ? error.message : String(error)}`,
        }),
    ),
  );
  if (!quiet)
    yield* Console.log(
      `Synced ${synchronized.changed.toLocaleString('en-US')} changed records (${synchronized.accepted} new, ${synchronized.updated} updated).${synchronized.deleted ? ` Removed ${synchronized.deleted.toLocaleString('en-US')} replayed records.` : ''}`,
    );
  return synchronized;
});

export const syncOnce = (quiet = false) => syncOnceProgram(quiet).pipe(Effect.scoped);

export const watchSync = (minutes: number, quiet = false) =>
  syncOnce(quiet).pipe(
    Effect.catch((error) =>
      Console.error(`${new Date().toISOString()} ${'message' in error ? error.message : String(error)}`),
    ),
    Effect.repeat(Schedule.spaced(`${minutes} minutes`)),
  );
