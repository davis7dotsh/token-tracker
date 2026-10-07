import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect } from 'effect';
import { collectUsage } from '../../src/lib/server/usage';
import { changedRecords, eventDigest } from '../../src/cli/checkpoint';

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
      value.version = 3;
      // An old cache contains stale metadata and must cause a source reparse.
      value.file.events = [];
      await writeFile(file, JSON.stringify(value));
    }
    expect(await collect()).toEqual(cold);
    for (const name of caches) expect(JSON.parse(await readFile(join(cacheDirectory, name), 'utf8')).version).toBe(4);
    await rm(join(home, '.claude'), { recursive: true });
    await rm(join(home, '.pi'), { recursive: true });
    const missing = await collect();
    expect(missing.events).toEqual([]);
    expect(missing.retractedIds).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('cold and warm caches preserve asymmetric advisor ambiguity including empty original ownership', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-advisor-ownership-cache-'));
  const cacheDirectory = join(home, 'cache');
  const claude = join(home, '.claude', 'projects', 'app');
  const assistant = (requestId: string, isSidechain: boolean, empty = false) => ({
    type: 'assistant',
    sessionId: 'session',
    timestamp: '2026-10-01T10:00:00Z',
    requestId,
    isSidechain,
    message: {
      id: 'shared-native-id',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: empty ? 0 : 100,
        output_tokens: empty ? 0 : 10,
        iterations: empty
          ? []
          : [{ type: 'advisor_message', model: 'claude-opus-4-6', input_tokens: 50, output_tokens: 5 }],
      },
    },
  });
  const jsonl = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  try {
    await mkdir(claude, { recursive: true });
    await writeFile(
      join(claude, 'parent.jsonl'),
      jsonl([assistant('original', false), assistant('empty-original', false, true)]),
    );
    await writeFile(join(claude, 'sidechain.jsonl'), jsonl([assistant('independent-child', true)]));
    const collect = () =>
      Effect.runPromise(
        collectUsage({ home, cacheDirectory, codexDirs: [], piDirs: [], grokDirs: [] }).pipe(
          Effect.provide(BunServices.layer),
        ),
      );
    const cold = await collect();
    expect(cold.events).toHaveLength(4);
    expect(cold.retractedIds).toBeUndefined();
    expect(cold.events.every((event) => event.inputTokens + event.outputTokens > 0)).toBe(true);
    expect(cold.events.filter((event) => event.model === 'claude-opus-4-6')).toHaveLength(2);
    expect(await collect()).toEqual(cold);
    const caches = await readdir(cacheDirectory);
    expect(caches).toHaveLength(2);
    const cached = await Promise.all(
      caches.map(async (name) => JSON.parse(await readFile(join(cacheDirectory, name), 'utf8'))),
    );
    expect(cached.flatMap((value) => value.file.emptyClaudeRequests ?? [])).toEqual([
      {
        id: 'claude:message:shared-native-id:empty-original',
        nativeMessageId: 'shared-native-id',
        sessionId: 'session',
      },
    ]);
    expect(cached.every((value) => value.version === 4)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('empty-only ownership never withdraws previously acknowledged sidechain usage on cold or warm collection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-empty-placeholder-cache-'));
  const cacheDirectory = join(home, 'cache');
  const claude = join(home, '.claude', 'projects', 'app');
  const assistant = (requestId: string, isSidechain: boolean, empty = false) => ({
    type: 'assistant',
    sessionId: 'session',
    timestamp: '2026-10-01T10:00:00Z',
    requestId,
    isSidechain,
    message: {
      id: 'shared-native-id',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: empty ? 0 : 100,
        output_tokens: empty ? 0 : 10,
        iterations: empty
          ? []
          : [{ type: 'advisor_message', model: 'claude-opus-4-6', input_tokens: 50, output_tokens: 5 }],
      },
    },
  });
  try {
    await mkdir(claude, { recursive: true });
    await writeFile(join(claude, 'sidechain.jsonl'), JSON.stringify(assistant('completed', true)) + '\n');
    const collect = () =>
      Effect.runPromise(
        collectUsage({ home, cacheDirectory, codexDirs: [], piDirs: [], grokDirs: [] }).pipe(
          Effect.provide(BunServices.layer),
        ),
      );
    const uploaded = await collect();
    expect(uploaded.events).toHaveLength(2);
    const checkpoint = {
      version: 1 as const,
      remote: 'https://test.example',
      deviceId: 'test-placeholder',
      syncedAt: '2026-10-01T10:01:00Z',
      eventDigests: Object.fromEntries(uploaded.events.map((event) => [event.id, eventDigest(event)])),
    };
    await writeFile(join(claude, 'parent.jsonl'), JSON.stringify(assistant('placeholder', false, true)) + '\n');
    const cold = await collect();
    expect(cold.events).toEqual(uploaded.events);
    expect(cold.retractedIds).toBeUndefined();
    expect(changedRecords(cold.events, checkpoint)).toEqual([]);
    expect(await collect()).toEqual(cold);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('advisor ordinal migration retires old IDs without withdrawing a retained advisor on cold or warm collection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-advisor-ordinal-cache-'));
  const cacheDirectory = join(home, 'cache');
  const claude = join(home, '.claude', 'projects', 'app');
  const mainId = 'claude:message:message:request';
  const advisorId = (index: number) =>
    `claude:advisor:${createHash('sha256')
      .update(JSON.stringify([mainId, index]))
      .digest('hex')}`;
  try {
    await mkdir(claude, { recursive: true });
    await writeFile(
      join(claude, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session',
        timestamp: '2026-10-01T10:00:00Z',
        requestId: 'request',
        message: {
          id: 'message',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            iterations: [
              { type: 'message', input_tokens: 2, output_tokens: 1 },
              { type: 'advisor_message', model: 'claude-opus-4-6', input_tokens: 10, output_tokens: 2 },
              { type: 'advisor_message', model: 'claude-haiku-4-5', input_tokens: 20, output_tokens: 4 },
            ],
          },
        },
      }) + '\n',
    );
    const collect = () =>
      Effect.runPromise(
        collectUsage({ home, cacheDirectory, codexDirs: [], piDirs: [], grokDirs: [] }).pipe(
          Effect.provide(BunServices.layer),
        ),
      );
    const cold = await collect();
    expect(cold.events).toHaveLength(3);
    expect(cold.events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0)).toBe(39);
    expect(cold.retractedIds).toEqual([advisorId(2)]);
    expect(cold.events.find((event) => event.id === advisorId(1))?.model).toBe('claude-haiku-4-5');
    const previous = cold.events.map((event) => ({
      ...event,
      id:
        event.model === 'claude-opus-4-6' ? advisorId(1) : event.model === 'claude-haiku-4-5' ? advisorId(2) : event.id,
    }));
    const checkpoint = {
      version: 1 as const,
      remote: 'https://test.example',
      deviceId: 'test-advisor-ordinal',
      syncedAt: '2026-10-01T10:01:00Z',
      eventDigests: Object.fromEntries(previous.map((event) => [event.id, eventDigest(event)])),
    };
    expect(
      changedRecords(cold.events, checkpoint)
        .map(({ event }) => event.id)
        .sort(),
    ).toEqual([advisorId(0), advisorId(1)].sort());
    expect(await collect()).toEqual(cold);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
