import { describe, expect, test } from 'bun:test';
import { Effect, Exit } from 'effect';
import type { UsageEvent } from '../../src/lib/shared/domain';
import { acknowledgeEvents, changedEvents, eventDigest } from '../../src/cli/checkpoint';
import { commitBatch } from '../../src/cli/sync';
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
});
