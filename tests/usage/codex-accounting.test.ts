import { describe, expect, test } from 'bun:test';
import { deduplicate, parseCodex, tokenTotal } from '../../src/lib/server/usage/parsers';

const stamp = (seconds: number) => new Date(Date.UTC(2026, 6, 10, 9, 0, 0) + seconds * 1000).toISOString();
const metadata = (id: string, parent?: string) => ({
  type: 'session_meta',
  timestamp: stamp(0),
  payload: { id, ...(parent ? { forked_from_id: parent } : {}) },
});
const start = (seconds: number, startedSeconds = seconds) => ({
  type: 'event_msg',
  timestamp: stamp(seconds),
  payload: { type: 'task_started', started_at: Date.parse(stamp(startedSeconds)) / 1000 },
});
const snapshot = (seconds: number, input: number, last?: number) => ({
  type: 'event_msg',
  timestamp: stamp(seconds),
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: input / 10 },
      ...(last !== undefined
        ? { last_token_usage: { input_tokens: last, cached_input_tokens: last / 2, output_tokens: last / 10 } }
        : {}),
    },
  },
});
const parse = (records: readonly unknown[], file = 'child.jsonl') =>
  parseCodex(records.map((record) => JSON.stringify(record)).join('\n') + '\n', file);
const total = (records: ReturnType<typeof parse>) =>
  deduplicate([records]).reduce((sum, entry) => sum + tokenTotal(entry.event), 0);

describe('Codex fork accounting', () => {
  test('UI refreshes with fresh timestamps and unchanged cumulative counters add no usage', () => {
    const parsed = parse([
      metadata('session'),
      snapshot(2, 1_000, 1_000),
      snapshot(2.5, 1_000, 1_000),
      snapshot(3, 1_000, 1_000),
      snapshot(10, 3_000, 2_000),
    ]);
    expect(total(parsed)).toBe(3_300);
    expect(parsed.events).toHaveLength(2);
  });

  for (const explicitLast of [false, true]) {
    test(`rewritten inherited requests across seconds leave only native usage (${explicitLast ? 'last usage' : 'counter deltas'})`, () => {
      const records = [
        metadata('child', 'parent'),
        metadata('parent'),
        { type: 'turn_context', payload: { model: 'gpt-5.5' } },
        start(0, -3600),
        snapshot(0, 100_000, explicitLast ? 100_000 : undefined),
        start(1, -1800),
        snapshot(2, 250_000, explicitLast ? 150_000 : undefined),
        start(8),
        { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
        snapshot(10, 255_000, explicitLast ? 5_000 : undefined),
      ];
      const parsed = parse(records);
      expect(total(parsed)).toBe(5_500);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].event.model).toBe('gpt-6-astra');
      expect(parsed.retractedIds).toHaveLength(2);
    });
  }

  test('copied-only forks without a later native task report zero new spend, even without ancestor metadata', () => {
    const parsed = parse([
      metadata('child', 'parent'),
      start(0, -3600),
      snapshot(0, 100_000, 100_000),
      snapshot(1, 200_000, 100_000),
    ]);
    expect(total(parsed)).toBe(0);
    expect(parsed.retractedIds).toHaveLength(2);
  });

  test('UUIDv7 turn creation distinguishes inherited and native tasks in older logs without started_at', () => {
    const parsed = parse([
      {
        type: 'session_meta',
        timestamp: '2026-03-12T23:44:19.488Z',
        payload: { id: 'child', forked_from_id: 'parent', timestamp: '2026-03-12T23:44:19.440Z' },
      },
      metadata('parent'),
      {
        type: 'event_msg',
        timestamp: '2026-03-12T23:44:19.489Z',
        payload: { type: 'task_started', turn_id: '019ce46f-8169-7763-838e-c0d19c407a20' },
      },
      snapshot(0, 100_000, 100_000),
      {
        type: 'event_msg',
        timestamp: '2026-03-12T23:44:22.335Z',
        payload: { type: 'task_started', turn_id: '019ce46f-d221-7812-867c-d95c9bc62d99' },
      },
      snapshot(10, 105_000, 5_000),
    ]);
    expect(total(parsed)).toBe(5_500);
    expect(parsed.retractedIds).toHaveLength(1);
  });

  test('a native task recorded across a second tick remains billable', () => {
    const parsed = parse([
      {
        type: 'session_meta',
        timestamp: '2026-07-10T09:00:00.960Z',
        payload: { id: 'child', parent_thread_id: 'parent', timestamp: '2026-07-10T09:00:00.960Z' },
      },
      { ...start(1, 0), timestamp: '2026-07-10T09:00:01.017Z' },
      snapshot(10, 5_000, 5_000),
    ]);
    expect(total(parsed)).toBe(5_500);
    expect(parsed.retractedIds).toBeUndefined();
  });

  test('same-second native fork requests and subsequent counter reset all remain billable', () => {
    const parsed = parse([
      metadata('child', 'missing-parent'),
      start(0),
      snapshot(0, 1_000, 1_000),
      snapshot(0.5, 2_000, 1_000),
      snapshot(8, 500, 500),
    ]);
    expect(total(parsed)).toBe(2_750);
    expect(parsed.events).toHaveLength(3);
  });

  test('nested copied prefixes need no readable parent and keep native request identities', () => {
    const parsed = parse([
      metadata('grandchild', 'child'),
      metadata('child', 'parent'),
      metadata('parent'),
      start(0, -3600),
      snapshot(0, 50_000, 50_000),
      start(1, -1800),
      snapshot(2, 100_000, 50_000),
      start(8),
      {
        type: 'token_usage_record',
        timestamp: stamp(10),
        payload: {
          thread_id: 'grandchild',
          response_id: 'native-child-response',
          usage: { input_tokens: 5_000, output_tokens: 500 },
        },
      },
      snapshot(10, 105_000, 5_000),
    ]);
    expect(total(parsed)).toBe(5_500);
    expect(parsed.events[0].event.id).toBe('codex:response:native-child-response');
  });

  test('a parent plus a child with rewritten counters counts all independent child requests once', () => {
    const parent = parse([metadata('parent'), start(-3600), snapshot(-3500, 100_000, 100_000)], 'parent.jsonl');
    const child = parse([
      metadata('child', 'parent'),
      metadata('parent'),
      start(0, -3600),
      snapshot(0, 100_000, 100_000),
      start(8),
      snapshot(10, 105_000, 5_000),
    ]);
    const entries = deduplicate([parent, child]);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(115_500);
    expect(entries.map((entry) => entry.event.sessionId).sort()).toEqual(['child', 'parent']);
  });
});
