import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { collectUsage } from '../../src/lib/server/usage';

test('cold, warm, and obsolete caches agree on canonical requests and replay withdrawals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-accounting-cache-'));
  const cacheDirectory = join(home, 'cache');
  const claude = join(home, '.claude', 'projects', 'app');
  const pi = join(home, '.pi', 'agent', 'sessions', 'app');
  const jsonl = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const assistant = (requestId: string, isSidechain: boolean, input: number) => ({
    type: 'assistant',
    sessionId: 'claude-session',
    timestamp: '2026-10-01T10:00:00Z',
    requestId,
    isSidechain,
    message: {
      id: 'native-message',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: input,
        output_tokens: 10,
        iterations: [{ type: 'advisor_message', model: 'claude-opus-4-6', input_tokens: input, output_tokens: 5 }],
      },
    },
  });
  const native = {
    type: 'message',
    id: 'native-entry',
    timestamp: '2026-10-01T10:00:00Z',
    message: {
      role: 'assistant',
      model: 'gpt-6-astra',
      usage: { input: 100, output: 10, cacheWrite: 20, cacheWrite1h: 12 },
    },
  };
  try {
    await mkdir(claude, { recursive: true });
    await mkdir(pi, { recursive: true });
    await writeFile(join(claude, 'parent.jsonl'), jsonl([assistant('original', false, 100)]));
    await writeFile(join(claude, 'sidechain.jsonl'), jsonl([assistant('replayed', true, 10_000)]));
    await writeFile(
      join(pi, '2026-10-01T09-59-00Z_parent.jsonl'),
      jsonl([{ type: 'session', id: 'parent', timestamp: '2026-10-01T09:59:00Z', cwd: home }, native]),
    );
    await writeFile(
      join(pi, 'child.jsonl'),
      jsonl([
        {
          type: 'session',
          id: 'child',
          timestamp: '2026-10-01T10:01:00Z',
          parentSession: join(pi, '2026-10-01T09-59-00Z_parent.jsonl'),
          cwd: home,
        },
        native,
        { ...native, id: 'child-call', timestamp: '2026-10-01T10:02:00Z' },
      ]),
    );
    const collect = () =>
      Effect.runPromise(
        collectUsage({ home, cacheDirectory, codexDirs: [], grokDirs: [] }).pipe(Effect.provide(BunServices.layer)),
      );
    const cold = await collect();
    const warm = await collect();
    expect(warm).toEqual(cold);
    expect(cold.events).toHaveLength(4);
    expect(cold.events.find((event) => event.model === 'claude-opus-4-6')?.inputTokens).toBe(100);
    expect(
      cold.events.filter((event) => event.harness === 'pi').every((event) => event.cacheWrite1hTokens === 12),
    ).toBe(true);
    expect(cold.retractedIds).toContain('claude:message:native-message:replayed');
    expect(cold.retractedIds).toContain('pi:child:native-entry');
    expect(cold.retractedIds?.filter((id) => id.startsWith('claude:advisor:'))).toHaveLength(1);
    const caches = await readdir(cacheDirectory);
    expect(caches).toHaveLength(4);
    for (const name of caches) {
      const file = join(cacheDirectory, name);
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.version = 2;
      // An old cache contains stale metadata and must cause a source reparse.
      value.file.events = [];
      await writeFile(file, JSON.stringify(value));
    }
    expect(await collect()).toEqual(cold);
    for (const name of caches) expect(JSON.parse(await readFile(join(cacheDirectory, name), 'utf8')).version).toBe(3);
    await rm(join(home, '.claude'), { recursive: true });
    await rm(join(home, '.pi'), { recursive: true });
    const missing = await collect();
    expect(missing.events).toEqual([]);
    expect(missing.retractedIds).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
