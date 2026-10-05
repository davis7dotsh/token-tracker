import { describe, expect, test } from 'bun:test';
import { deduplicate, parsePi, tokenTotal } from '../../src/lib/server/usage/parsers';

const session = (id: string, parentSession?: string, timestamp = '2026-10-01T10:01:00Z') => ({
  type: 'session',
  version: 3,
  id,
  timestamp,
  cwd: `/work/${id}`,
  ...(parentSession ? { parentSession } : {}),
});
const message = (id: string, timestamp: string, output = 10) => ({
  type: 'message',
  id,
  timestamp,
  message: {
    role: 'assistant',
    model: 'gpt-6-astra',
    usage: { input: 100, output, cacheRead: 50, cacheWrite: 0 },
  },
});
const parse = (header: ReturnType<typeof session>, rows: readonly unknown[]) =>
  parsePi([header, ...rows].map((row) => JSON.stringify(row)).join('\n'), `${header.id}.jsonl`);
const sourcePath = (id: string) => `/home/user/.pi/agent/sessions/project/2026-10-01T10-00-00-000Z_${id}.jsonl`;

describe('Pi native branch accounting', () => {
  test('fork copies retain original call ownership while new child calls remain counted', () => {
    const inherited = message('abc12345', '2026-10-01T10:00:30Z');
    const own = message('def12345', '2026-10-01T10:01:30Z');
    const parent = parse(session('parent'), [inherited]);
    const child = parse(session('child', sourcePath('parent')), [inherited, own]);
    const entries = deduplicate([parent, child]);
    expect(entries).toHaveLength(2);
    expect(entries.map(({ event }) => [event.id, event.sessionId])).toEqual([
      ['pi:parent:abc12345', 'parent'],
      ['pi:child:def12345', 'child'],
    ]);
    expect(entries.reduce((sum, { event }) => sum + tokenTotal(event), 0)).toBe(320);
    expect(child.retractedIds).toEqual(['pi:child:abc12345']);
  });

  test('nested copies resolve the original owner in any file ordering, including a missing ancestor', () => {
    for (const order of [false, true]) {
      const inherited = message('abc12345', '2026-10-01T10:00:30Z');
      const branchCall = message('def12345', '2026-10-01T10:01:30Z');
      const leafCall = message('ghi12345', '2026-10-01T10:02:30Z');
      const parent = parse(session('parent'), [inherited]);
      const child = parse(session('child', sourcePath('parent')), [inherited, branchCall]);
      const leaf = parse(session('leaf', sourcePath('child'), '2026-10-01T10:02:00Z'), [
        inherited,
        branchCall,
        leafCall,
      ]);
      const files = order ? [leaf, child, parent] : [parent, child, leaf];
      expect(
        deduplicate(files)
          .map(({ event }) => event.id)
          .sort(),
      ).toEqual(['pi:child:def12345', 'pi:leaf:ghi12345', 'pi:parent:abc12345']);
      const missingParent = parse(session('child', sourcePath('parent')), [inherited, branchCall]);
      const missingLeaf = parse(session('leaf', sourcePath('child'), '2026-10-01T10:02:00Z'), [
        inherited,
        branchCall,
        leafCall,
      ]);
      expect(
        deduplicate([missingLeaf, missingParent])
          .map(({ event }) => event.id)
          .sort(),
      ).toEqual(['pi:child:def12345', 'pi:leaf:ghi12345', 'pi:parent:abc12345']);
    }
  });

  test('a fresh child context and unrelated sessions with identical short IDs are independent calls', () => {
    const own = message('abc12345', '2026-10-01T10:01:30Z');
    const parent = parse(session('parent'), [message('abc12345', '2026-10-01T10:00:30Z')]);
    const freshChild = parse(session('child', sourcePath('parent')), [own]);
    const independent = parse(session('independent'), [own]);
    expect(deduplicate([parent, freshChild, independent])).toHaveLength(3);
    expect(freshChild.retractedIds).toBeUndefined();
  });

  test('an original correction wins over a larger copied snapshot, including a fork timestamp tie', () => {
    const parent = parse(session('parent'), [message('abc12345', '2026-10-01T10:01:00Z', 5)]);
    const child = parse(session('child', sourcePath('parent')), [message('abc12345', '2026-10-01T10:01:00Z', 90)]);
    const entries = deduplicate([child, parent]);
    expect(entries).toHaveLength(1);
    expect(entries[0].event).toMatchObject({ sessionId: 'parent', outputTokens: 5 });
  });

  test('derived recordType transcript copies have no billable native entries', () => {
    const copied = message('abc12345', '2026-10-01T10:00:30Z');
    const derived = { recordType: 'message', message: copied.message, timestamp: copied.timestamp };
    expect(parsePi(JSON.stringify(derived), 'subagent-artifacts/result.jsonl').events).toEqual([]);
  });
});
