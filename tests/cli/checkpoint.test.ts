import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import type { UsageEvent } from '../../src/lib/shared/domain';
import { acknowledgeEvents, changedEvents, changedRecords, eventDigest } from '../../src/cli/checkpoint';
import { commitBatch, commitChangedBatches } from '../../src/cli/sync';
import type { Checkpoint } from '../../src/cli/state';

const event = (id: string, timestamp = '2020-01-01T00:00:00Z'): UsageEvent => ({
  id,
  timestamp,
  harness: 'codex',
  model: 'gpt-5',
  project: '/work/app',
  repository: 'github.com/davis7/app',
  sessionId: 'session',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 20,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.002,
  costKnown: true,
});
const empty: Checkpoint = {
  version: 1,
  remote: 'https://dashboard.example',
  deviceId: 'machine',
  syncedAt: null,
  eventDigests: {},
};

describe('incremental sync checkpoints', () => {
  test('aggregate accounting metadata uploads corrections without changing existing checkpoints', () => {
    const original = event('old');
    expect(eventDigest(original)).toBe('caeff00cab6c83509b9564517a23c1358f0dd9e0aa24b7874a88f0862869b53f');
    const aggregate = { ...original, harness: 'grok' as const, requests: 3, reportedCostUsd: 0.02673624 };
    const checkpoint = acknowledgeEvents(empty, [aggregate], '2026-10-04T00:00:00Z');
    expect(changedEvents([aggregate], checkpoint)).toEqual([]);
    const calls = { ...aggregate, requests: 4 };
    const nativeCost = { ...aggregate, reportedCostUsd: 0.03 };
    expect(changedEvents([calls], checkpoint)).toEqual([calls]);
    expect(changedEvents([nativeCost], checkpoint)).toEqual([nativeCost]);
  });

  test('repeated collection is idempotent while old imported logs and corrections are sent', () => {
    const original = event('old');
    const checkpoint = acknowledgeEvents(empty, [original], '2026-10-03T01:00:00Z');
    expect(changedEvents([original], checkpoint)).toEqual([]);
    const correction = { ...original, costUsd: 0.004, outputTokens: 20 };
    const imported = event('imported', '2019-01-01T00:00:00Z');
    expect(changedEvents([correction, imported], checkpoint)).toEqual([correction, imported]);
    expect(eventDigest({ ...original, deviceId: 'another' })).toBe(eventDigest(original));
  });

  test('offline failures preserve the checkpoint and retry the complete unacknowledged batch', async () => {
    const events = [event('one'), event('two')];
    const stored: { checkpoint: Checkpoint | null } = { checkpoint: null };
    const persist = (value: Checkpoint) =>
      Effect.sync(() => {
        stored.checkpoint = value;
      });
    const failed = await Effect.runPromiseExit(commitBatch(empty, events, Effect.fail('offline'), persist));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(stored.checkpoint).toBeNull();
    expect(changedEvents(events, empty)).toEqual(events);
    const ack = { accepted: 2, updated: 0, deleted: 0, receivedAt: '2026-10-03T02:00:00Z' };
    const success = await Effect.runPromise(commitBatch(empty, events, Effect.succeed(ack), persist));
    expect(stored.checkpoint).toEqual(success.checkpoint);
    expect(changedEvents(events, success.checkpoint)).toEqual([]);
  });

  test('partial batch success retains acknowledged progress without skipping the next failed batch', async () => {
    const first = [event('first')];
    const second = [event('second')];
    let persisted = empty;
    const persist = (value: Checkpoint) =>
      Effect.sync(() => {
        persisted = value;
      });
    const ack = { accepted: 1, updated: 0, deleted: 0, receivedAt: '2026-10-03T02:00:00Z' };
    const committed = await Effect.runPromise(commitBatch(empty, first, Effect.succeed(ack), persist));
    await Effect.runPromiseExit(commitBatch(committed.checkpoint, second, Effect.fail('offline'), persist));
    expect(changedEvents([...first, ...second], persisted)).toEqual(second);
  });

  test('large imports journal each acknowledgement and compact the full checkpoint once', async () => {
    const events = Array.from({ length: 1_501 }, (_, index) => event(`import-${index}`));
    const writes: Checkpoint[] = [];
    const snapshots: Checkpoint[] = [];
    const result = await Effect.runPromise(
      commitChangedBatches(
        empty,
        changedRecords(events, empty),
        (batch) =>
          Effect.succeed({ accepted: batch.length, updated: 0, deleted: 0, receivedAt: '2026-10-03T02:00:00Z' }),
        (delta) =>
          Effect.sync(() => {
            writes.push(structuredClone(delta));
          }),
        (checkpoint) =>
          Effect.sync(() => {
            snapshots.push(structuredClone(checkpoint));
          }),
      ),
    );
    expect(writes.map((delta) => Object.keys(delta.eventDigests).length)).toEqual([500, 500, 500, 1]);
    expect(snapshots).toHaveLength(1);
    expect(result.accepted).toBe(1_501);
    expect(changedEvents(events, snapshots[0])).toEqual([]);
    expect(empty.eventDigests).toEqual({});
  });

  test('a later upload failure retains only acknowledged journal deltas for retry', async () => {
    const events = Array.from({ length: 501 }, (_, index) => event(`retry-${index}`));
    let persisted = empty;
    let uploads = 0;
    let compacted = false;
    const outcome = await Effect.runPromiseExit(
      commitChangedBatches(
        empty,
        changedRecords(events, empty),
        (batch) =>
          ++uploads === 1
            ? Effect.succeed({ accepted: batch.length, updated: 0, deleted: 0, receivedAt: '2026-10-03T02:00:00Z' })
            : Effect.fail('offline'),
        (delta) =>
          Effect.sync(() => {
            persisted = { ...delta, eventDigests: { ...persisted.eventDigests, ...delta.eventDigests } };
          }),
        () =>
          Effect.sync(() => {
            compacted = true;
          }),
      ),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(compacted).toBe(false);
    expect(changedEvents(events, persisted)).toEqual([events[500]]);
  });

  test('heartbeats append a tiny durable delta without copying or rewriting historical fingerprints', async () => {
    const checkpoint = acknowledgeEvents(empty, [event('historical')], '2026-10-03T01:00:00Z');
    const deltas: Checkpoint[] = [];
    let compacted = false;
    const result = await Effect.runPromise(
      commitChangedBatches(
        checkpoint,
        [],
        (batch) =>
          Effect.sync(() => {
            expect(batch).toEqual([]);
            return { accepted: 0, updated: 0, deleted: 0, receivedAt: '2026-10-03T02:00:00Z' };
          }),
        (delta) =>
          Effect.sync(() => {
            deltas.push(delta);
          }),
        () =>
          Effect.sync(() => {
            compacted = true;
          }),
      ),
    );
    expect(deltas[0].eventDigests).toEqual({});
    expect(compacted).toBe(false);
    expect(result.checkpoint.eventDigests).toBe(checkpoint.eventDigests);
    expect(result.checkpoint.syncedAt).toBe('2026-10-03T02:00:00Z');
  });
});
