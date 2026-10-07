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
const advisorRecord = (
  messageId: string,
  requestId: string,
  { sidechain = false, mainOutput = 2, advisorOutput = 4, mainInput = 2, mainCache = 20, includeAdvisor = true } = {},
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-01T08:00:00Z',
    sessionId: 'session',
    requestId,
    isSidechain: sidechain,
    cwd: '/work/project',
    message: {
      id: messageId,
      model: 'claude-fable-5-1',
      usage: {
        input_tokens: mainInput,
        output_tokens: mainOutput,
        cache_read_input_tokens: mainCache,
        speed: 'fast',
        iterations: includeAdvisor
          ? [
              { type: 'message', model: null, input_tokens: mainInput, output_tokens: mainOutput },
              {
                type: 'advisor_message',
                model: 'claude-advisor',
                input_tokens: 10,
                output_tokens: advisorOutput,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 8,
                cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 5 },
                output_tokens_details: { thinking_tokens: 99 },
              },
              { type: 'advisor_message', model: null, input_tokens: 50_000 },
              { type: 'advisor_message', model: '', input_tokens: 50_000 },
              { type: 'message', model: 'claude-advisor', input_tokens: 50_000 },
            ]
          : [],
      },
    },
  });

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

  test('requestless native response fragments with distinct timestamps and transcript UUIDs bill once', () => {
    const first = {
      type: 'assistant',
      timestamp: '2026-10-01T08:00:00.000Z',
      sessionId: 'session',
      uuid: 'fragment-first',
      parentUuid: 'earlier-transcript-entry',
      message: {
        id: 'msg_01NativeResponse',
        model: 'claude-fable-5-1',
        usage: { input_tokens: 2, output_tokens: 87, cache_read_input_tokens: 25_080 },
        stop_reason: 'tool_use',
      },
    };
    const second = {
      ...first,
      timestamp: '2026-10-01T08:00:00.018Z',
      uuid: 'fragment-second',
      parentUuid: first.uuid,
    };
    const entries = deduplicate([parsed(JSON.stringify(first), JSON.stringify(second))]);
    expect(entries).toHaveLength(1);
    expect(tokenTotal(entries[0].event)).toBe(25_169);
    expect(entries[0].event.id).toBe('claude:message:msg_01NativeResponse:');
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

  test('advisor usage is additional, model-specific accounting while ordinary iterations remain included once', () => {
    const entries = deduplicate([parsed(advisorRecord('parent', 'request-parent'))]);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(76);
    expect(entries.find((entry) => entry.event.model === 'claude-fable-5-1')?.event.id).toBe(
      'claude:message:parent:request-parent',
    );
    expect(entries.find((entry) => entry.event.model === 'claude-advisor')).toMatchObject({
      event: {
        sessionId: 'session',
        project: '/work/project',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 30,
        cacheWriteTokens: 8,
        reasoningTokens: 4,
      },
      cacheWrite1h: 3,
      tier: 'priority',
    });
  });

  test('advisor streaming rewrites and copied transcripts retain the final counters once', () => {
    const first = advisorRecord('parent', 'request-parent');
    const final = advisorRecord('parent', 'request-parent', { mainOutput: 10, advisorOutput: 9 });
    const entries = deduplicate([parsed(first, final), parsed(first, final)]);
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(89);
    expect(entries.find((entry) => entry.event.model === 'claude-advisor')?.event.outputTokens).toBe(9);
  });

  test.each([false, true])(
    'rewritten sidechain advisors retain parent ownership regardless of ordering (%s)',
    (reverse) => {
      const parent = parsed(advisorRecord('parent', 'original'));
      const child = parsed(
        advisorRecord('parent', 'replay', { sidechain: true, mainOutput: 999, advisorOutput: 999 }),
        advisorRecord('child', 'native-child', { sidechain: true }),
      );
      const entries = deduplicate(reverse ? [child, parent] : [parent, child]);
      expect(entries).toHaveLength(4);
      expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(152);
      expect(entries.filter((entry) => entry.event.model === 'claude-advisor')).toHaveLength(2);
      expect(child.retractedIds).toHaveLength(2);
      expect(child.retractedIds).toContain('claude:message:parent:replay');
      expect(deduplicate(reverse ? [child, parent] : [parent, child])).toEqual(entries);
    },
  );

  test('advisors remain billable when the main usage counters are empty', () => {
    const entries = deduplicate([
      parsed(advisorRecord('parent', 'request-parent', { mainInput: 0, mainOutput: 0, mainCache: 0 })),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.model).toBe('claude-advisor');
    expect(tokenTotal(entries[0].event)).toBe(52);
  });

  test('reused parent message IDs keep distinct advisor requests and ambiguous sidechains', () => {
    const file = parsed(
      advisorRecord('gateway', 'request-a'),
      advisorRecord('gateway', 'request-b'),
      advisorRecord('gateway', 'request-child', { sidechain: true }),
    );
    const entries = deduplicate([file]);
    expect(entries).toHaveLength(6);
    expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(228);
    expect(file.retractedIds).toBeUndefined();
  });

  test.each([false, true])(
    'asymmetric advisor presence preserves ambiguous parent requests in either file order (%s)',
    (reverse) => {
      const parent = parsed(
        advisorRecord('gateway', 'request-a'),
        advisorRecord('gateway', 'request-b', { includeAdvisor: false }),
      );
      const child = parsed(advisorRecord('gateway', 'request-child', { sidechain: true }));
      const files = reverse ? [child, parent] : [parent, child];
      const entries = deduplicate(files);
      expect(entries).toHaveLength(5);
      expect(entries.filter((entry) => entry.event.model === 'claude-advisor')).toHaveLength(2);
      expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(176);
      expect(child.retractedIds).toBeUndefined();
      expect(deduplicate(files)).toEqual(entries);
    },
  );

  test.each([false, true])(
    'zero-main advisor requests preserve ambiguous parent ownership in either file order (%s)',
    (reverse) => {
      const parent = parsed(
        advisorRecord('gateway', 'request-a', { mainInput: 0, mainOutput: 0, mainCache: 0 }),
        advisorRecord('gateway', 'request-b', { includeAdvisor: false }),
      );
      const child = parsed(advisorRecord('gateway', 'request-child', { sidechain: true }));
      const entries = deduplicate(reverse ? [child, parent] : [parent, child]);
      expect(entries).toHaveLength(4);
      expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(152);
      expect(child.retractedIds).toBeUndefined();
    },
  );

  test.each([false, true])(
    'empty original requests prove ambiguity without emitting zero-token usage (%s)',
    (reverse) => {
      const parent = parsed(
        advisorRecord('gateway', 'request-a'),
        advisorRecord('gateway', 'request-b', { includeAdvisor: false, mainInput: 0, mainOutput: 0, mainCache: 0 }),
      );
      const child = parsed(advisorRecord('gateway', 'request-child', { sidechain: true }));
      const entries = deduplicate(reverse ? [child, parent] : [parent, child]);
      expect(entries).toHaveLength(4);
      expect(entries.reduce((sum, entry) => sum + tokenTotal(entry.event), 0)).toBe(152);
      expect(entries.every((entry) => tokenTotal(entry.event) > 0)).toBe(true);
      expect(parent.emptyClaudeRequests).toEqual([
        { id: 'claude:message:gateway:request-b', nativeMessageId: 'gateway', sessionId: 'session' },
      ]);
      expect(child.retractedIds).toBeUndefined();
    },
  );

  test('streamed empty placeholders stop requiring separate ownership once main or advisor usage is present', () => {
    const empty = advisorRecord('gateway', 'request-a', {
      includeAdvisor: false,
      mainInput: 0,
      mainOutput: 0,
      mainCache: 0,
    });
    const file = parsed(
      empty,
      advisorRecord('gateway', 'request-a', { mainInput: 0, mainOutput: 0, mainCache: 0 }),
      empty,
    );
    expect(file.emptyClaudeRequests).toBeUndefined();
    expect(deduplicate([file])).toHaveLength(1);
  });

  test('advisors inherit a proven parent replay decision even when its original has no advisor row', () => {
    const parent = parsed(advisorRecord('gateway', 'original', { includeAdvisor: false }));
    const child = parsed(advisorRecord('gateway', 'replayed', { sidechain: true }));
    const entries = deduplicate([child, parent]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.id).toBe('claude:message:gateway:original');
    expect(child.retractedIds).toHaveLength(2);
  });
});
