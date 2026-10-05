import { describe, expect, test } from 'bun:test';
import { deduplicate, parseClaude, tokenTotal } from '../../src/lib/server/usage/parsers';

const record = (
  messageId: string,
  requestId: string,
  { sidechain = false, sessionId = 'session', cacheReadTokens = 20, outputTokens = 10 } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-01T08:00:00Z',
    sessionId,
    requestId,
    isSidechain: sidechain,
    message: {
      id: messageId,
      model: 'claude-fable-5-1',
      usage: { input_tokens: 2, cache_read_input_tokens: cacheReadTokens, output_tokens: outputTokens },
    },
  });
const parsed = (...records: string[]) => parseClaude(`${records.join('\n')}\n`, 'session.jsonl');

describe('Claude request accounting', () => {
  test.each([false, true])(
    'parent request wins a rewritten sidechain replay regardless of ordering (%s)',
    (reverse) => {
      const parent = parsed(record('message:parent', 'request:parent'));
      const child = parsed(
        record('message:parent', 'request:replay', { sidechain: true, cacheReadTokens: 50_000 }),
        record('message:child', 'request:child', { sidechain: true, cacheReadTokens: 700, outputTokens: 30 }),
      );
      const files = reverse ? [child, parent] : [parent, child];
      const entries = deduplicate(files);
      expect(entries.map((entry) => entry.event.id).sort()).toEqual([
        'claude:message:message:child:request:child',
        'claude:message:message:parent:request:parent',
      ]);
      expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(764);
      expect(child.retractedIds).toEqual(['claude:message:message:parent:request:replay']);
      expect(entries.find((entry) => entry.event.id.endsWith('request:parent'))?.event.cacheReadTokens).toBe(20);
    },
  );

  test('copied parent sessions retain each route used by later rewritten sidechain history', () => {
    const parent = parsed(record('parent', 'original', { sessionId: 'parent-session' }));
    const copy = parsed(record('parent', 'original', { sessionId: 'copied-session' }));
    const sidechain = parsed(
      record('parent', 'replay', { sessionId: 'copied-session', sidechain: true, cacheReadTokens: 50_000 }),
    );
    const files = [parent, copy, sidechain];
    expect(deduplicate(files)).toHaveLength(1);
    expect(sidechain.retractedIds).toEqual(['claude:message:parent:replay']);
  });

  test('distinct requests sharing a main-thread message ID keep their own usage', () => {
    const file = parsed(record('gateway', 'request-a'), record('gateway', 'request-b', { outputTokens: 20 }));
    const entries = deduplicate([file]);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(74);
    expect(file.retractedIds).toBeUndefined();
  });

  test('unmatched child requests and messages from distinct sessions remain counted', () => {
    const file = parsed(
      record('parent', 'request-parent'),
      record('parent', 'request-unrelated', { sessionId: 'other-session', sidechain: true, cacheReadTokens: 300 }),
      record('child-only', 'request-child', { sidechain: true, cacheReadTokens: 700 }),
    );
    expect(deduplicate([file])).toHaveLength(3);
    expect(file.retractedIds).toBeUndefined();
  });

  test('ambiguous reused gateway message IDs preserve requests without inventing ancestry', () => {
    const file = parsed(
      record('gateway', 'request-a'),
      record('gateway', 'request-b'),
      record('gateway', 'request-child', { sidechain: true }),
    );
    expect(deduplicate([file])).toHaveLength(3);
    expect(file.retractedIds).toBeUndefined();
  });

  test('same-request streaming fragments deduplicate while retaining final output and a live ID', () => {
    const file = parsed(
      record('parent', 'request-parent', { outputTokens: 2 }),
      record('parent', 'request-parent', { outputTokens: 10 }),
      record('parent', 'request-parent', { sidechain: true, cacheReadTokens: 50_000 }),
    );
    const entries = deduplicate([file]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.outputTokens).toBe(10);
    expect(entries[0].event.cacheReadTokens).toBe(20);
    expect(file.retractedIds).toBeUndefined();
  });

  test('repeated collection preserves canonical usage and the replay withdrawal', () => {
    const file = parsed(
      record('parent', 'request-parent'),
      record('parent', 'request-replay', { sidechain: true, cacheReadTokens: 50_000 }),
    );
    const first = deduplicate([file]);
    const second = deduplicate([file]);
    expect(second).toEqual(first);
    expect(second.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(32);
    expect(file.retractedIds).toEqual(['claude:message:parent:request-replay']);
  });
});
