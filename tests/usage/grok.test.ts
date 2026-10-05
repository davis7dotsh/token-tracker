import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import type { SourceStatus } from '../../src/lib/shared/domain';
import { collectGrokFiles } from '../../src/lib/server/usage/grok';
import { collectUsage } from '../../src/lib/server/usage';
import { deduplicate } from '../../src/lib/server/usage/parsers';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-tracker-grok-'));
  temporary.push(root);
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  return { root, sessions, cache: join(root, 'cache') };
};
// Accounting shape and counters observed in Grok 1.0.46, with synthetic IDs.
const counters = {
  inputTokens: 32211,
  outputTokens: 104,
  cachedReadTokens: 17152,
  cacheCreationTokens: 0,
  reasoningTokens: 67,
  totalTokens: 32315,
  modelCalls: 2,
  costUsdTicks: 267362400,
};
const usage = (overrides: Record<string, unknown> = {}, model = 'grok-4.7-build-fast') => ({
  ...counters,
  ...overrides,
  modelUsage: { [model]: { ...counters, ...overrides } },
});
const turn = (number: number, overrides: Record<string, unknown> = {}) => ({
  turnNumber: number,
  endedAt: `2026-09-28T05:55:${10 + number}.538972329+00:00`,
  ...usage(),
  ...overrides,
});
const ledger = (id: string, turns = [turn(1)]) => ({
  sessionId: id,
  updatedAt: '2026-09-28T05:55:11.538972329+00:00',
  session: { ...usage(), turnCount: turns.length },
  turns,
});
const update = (number = 1, overrides: Record<string, unknown> = {}) => ({
  timestamp: 1790574911,
  method: '_x.ai/session/update',
  params: {
    sessionId: 'example-session',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 't3-xai-prompt-1',
      stop_reason: 'end_turn',
      usage: usage({ numTurns: 2, apiDurationMs: 2000 }),
      ...overrides,
    },
    _meta: { eventId: `example-session-${number * 100}`, agentTimestampMs: 1790574911539 + number },
  },
});
const saveSession = async (
  sessions: string,
  id: string,
  options: {
    ledger?: unknown;
    updates?: readonly unknown[];
    metadata?: Record<string, unknown> | null;
    group?: string;
  } = {},
) => {
  const group = options.group ?? encodeURIComponent('/work/app');
  const path = join(sessions, group, id);
  await mkdir(path, { recursive: true });
  if (options.metadata !== null)
    await writeFile(
      join(path, 'summary.json'),
      JSON.stringify({
        info: { id, cwd: '/work/app' },
        created_at: '2026-09-28T05:55:07.759486361Z',
        current_model_id: 'grok-4.7-build-fast',
        session_kind: 'headless',
        ...options.metadata,
      }),
    );
  if (options.ledger !== undefined)
    await writeFile(
      join(path, 'usage.json'),
      typeof options.ledger === 'string' ? options.ledger : JSON.stringify(options.ledger),
    );
  if (options.updates)
    await writeFile(join(path, 'updates.jsonl'), `${options.updates.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return path;
};
const collect = async (
  root: string,
  options: { cache?: string; streamRead?: (file: string) => void; tinyChunks?: boolean } = {},
) => {
  const source: { -readonly [K in keyof SourceStatus]: SourceStatus[K] } = {
    harness: 'grok',
    path: root,
    files: 0,
    events: 0,
    status: 'missing',
  };
  const retained = new Set<string>();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* collectGrokFiles([{ source, index: 3 }], options.cache, retained).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stream: (file, settings) => {
            options.streamRead?.(file);
            return fs.stream(file, { ...settings, ...(options.tinyChunks ? { chunkSize: 7 } : {}) });
          },
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
  return { ...result, source, retained, events: deduplicate(result.files).map((entry) => entry.event) };
};

describe('Grok Build accounting collection', () => {
  test('uses compact per-model turns once, with inclusive cache/reasoning normalization and native costs/calls', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'modern', {
      ledger: ledger('modern'),
      updates: [update()],
    });
    const reads: string[] = [];
    const result = await collect(fixture.sessions, { streamRead: (file) => reads.push(file) });
    expect(result.source.status).toBe('ready');
    expect(result.source.files).toBe(1);
    expect(result.source.events).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.files[0].events[0].source).toBe(3);
    expect(result.events[0]).toMatchObject({
      harness: 'grok',
      sessionId: 'modern',
      timestamp: '2026-09-28T05:55:11.538Z',
      project: '/work/app',
      model: 'grok-4.7-build-fast',
      inputTokens: 15059,
      outputTokens: 104,
      cacheReadTokens: 17152,
      cacheWriteTokens: 0,
      reasoningTokens: 67,
      requests: 2,
      costUsd: 0.02673624,
      reportedCostUsd: 0.02673624,
      costKnown: true,
    });
    expect(reads.some((file) => file.endsWith('updates.jsonl'))).toBe(false);
  });

  test('warm cache skips raw accounting, invalidates metadata/counter corrections, and contains no private content', async () => {
    const fixture = await directory();
    const session = await saveSession(fixture.sessions, 'cached', {
      ledger: ledger('cached'),
      metadata: { session_summary: 'private title', agent_profile: { prompt: 'private instructions' } },
    });
    const reads: string[] = [];
    const options = { cache: fixture.cache, streamRead: (file: string) => reads.push(file) };
    const first = await collect(fixture.sessions, options);
    expect((await collect(fixture.sessions, options)).events).toEqual(first.events);
    expect(reads.filter((file) => file.endsWith('usage.json'))).toHaveLength(1);
    const [cachedName] = await readdir(fixture.cache);
    expect(first.retained.has(cachedName)).toBe(true);
    const cachedPath = join(fixture.cache, cachedName);
    const cached = await readFile(cachedPath, 'utf8');
    expect(cached).not.toContain('private');
    expect((await stat(cachedPath)).mode & 0o777).toBe(0o600);
    const original = await stat(join(session, 'usage.json'));
    const raw = await readFile(join(session, 'usage.json'), 'utf8');
    await writeFile(join(session, 'usage.json'), raw.replaceAll('"outputTokens":104', '"outputTokens":101'));
    await utimes(join(session, 'usage.json'), original.atime, original.mtime);
    const corrected = await collect(fixture.sessions, options);
    expect(corrected.events[0].outputTokens).toBe(101);
    expect(corrected.events[0].id).toBe(first.events[0].id);
    expect(reads.filter((file) => file.endsWith('usage.json'))).toHaveLength(2);
    await writeFile(join(session, 'summary.json'), JSON.stringify({ info: { id: 'cached', cwd: '/work/renamed' } }));
    expect((await collect(fixture.sessions, options)).events[0].project).toBe('/work/renamed');
    expect(reads.filter((file) => file.endsWith('usage.json'))).toHaveLength(3);
    await writeFile(cachedPath, '{corrupt');
    expect((await collect(fixture.sessions, options)).events[0].project).toBe('/work/renamed');
    expect(reads.filter((file) => file.endsWith('usage.json'))).toHaveLength(4);
    const before = await readFile(cachedPath, 'utf8');
    await collect(fixture.sessions);
    expect(await readFile(cachedPath, 'utf8')).toBe(before);
  });

  test('streams real legacy envelopes, keeps reused T3 prompt IDs distinct, and transitions to ledger IDs', async () => {
    const fixture = await directory();
    const session = await saveSession(fixture.sessions, 'legacy', {
      updates: [
        { params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'private user prompt' } } } },
        update(1),
        { params: { update: { sessionUpdate: 'tool_call', rawInput: 'private tool arguments' } } },
        update(2),
      ],
    });
    const legacy = await collect(fixture.sessions, { cache: fixture.cache, tinyChunks: true });
    expect(legacy.events).toHaveLength(2);
    expect(legacy.events[0].id).not.toBe(legacy.events[1].id);
    expect(legacy.events.reduce((sum, event) => sum + (event.requests ?? 0), 0)).toBe(4);
    expect(legacy.source.status).toBe('ready');
    const [cacheName] = await readdir(fixture.cache);
    expect(await readFile(join(fixture.cache, cacheName), 'utf8')).not.toContain('private');
    const reads: string[] = [];
    await collect(fixture.sessions, { cache: fixture.cache, streamRead: (file) => reads.push(file) });
    expect(reads.some((file) => file.endsWith('updates.jsonl'))).toBe(false);
    await writeFile(join(session, 'usage.json'), JSON.stringify(ledger('legacy', [turn(1), turn(2)])));
    const modern = await collect(fixture.sessions);
    expect(modern.events.map((event) => event.id)).toEqual(legacy.events.map((event) => event.id));
    expect(modern.events.map((event) => event.inputTokens)).toEqual([15059, 15059]);
  });

  test('replayed native completion events replace corrections without shifting later user-turn identities', async () => {
    const fixture = await directory();
    const session = await saveSession(fixture.sessions, 'replayed', {
      updates: [update(1), update(1, { usage: usage({ outputTokens: 90 }) }), update(2)],
    });
    const legacy = await collect(fixture.sessions);
    expect(legacy.events).toHaveLength(2);
    expect(legacy.events.map((event) => event.outputTokens)).toEqual([90, 104]);
    await writeFile(
      join(session, 'usage.json'),
      JSON.stringify(ledger('replayed', [turn(1, usage({ outputTokens: 90 })), turn(2)])),
    );
    expect((await collect(fixture.sessions)).events.map((event) => event.id)).toEqual(
      legacy.events.map((event) => event.id),
    );
  });

  test('a malformed completion replay preserves earlier valid accounting and reports the damaged correction', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'damaged-replay', {
      updates: [update(1), update(1, { usage: usage({ inputTokens: 'broken counter' }) }), update(2)],
    });
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.inputTokens)).toEqual([15059, 15059]);
    expect(result.source.status).toBe('partial');
    expect(result.warnings.join(' ')).toContain('1 malformed');
  });

  test('a malformed ledger falls back without hiding valid history; bad completed JSONL records report partial', async () => {
    const fixture = await directory();
    const session = await saveSession(fixture.sessions, 'broken', { ledger: '{broken', updates: [update()] });
    await appendFile(join(session, 'updates.jsonl'), 'not json\n{"incomplete":');
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(1);
    expect(result.source.status).toBe('partial');
    expect(result.warnings.join(' ')).toContain('malformed');
    expect(result.warnings.join(' ')).not.toContain('not json');
    await writeFile(join(session, 'usage.json'), JSON.stringify(ledger('broken')));
    expect((await collect(fixture.sessions)).source.status).toBe('ready');
  });

  test('missing and empty sources have clear status; missing summary uses encoded cwd or .cwd', async () => {
    const fixture = await directory();
    expect((await collect(join(fixture.root, 'missing'))).source.status).toBe('missing');
    expect((await collect(fixture.sessions)).source.status).toBe('empty');
    await saveSession(fixture.sessions, 'encoded', { ledger: ledger('encoded'), metadata: null });
    await saveSession(fixture.sessions, 'long', {
      ledger: ledger('long'),
      metadata: null,
      group: 'hashed-project-name',
    });
    await writeFile(join(fixture.sessions, 'hashed-project-name', '.cwd'), '/work/long-project');
    const result = await collect(fixture.sessions);
    expect(result.events.map((event) => event.project).sort()).toEqual(['/work/app', '/work/long-project']);
    const file = join(fixture.root, 'plain-file');
    await writeFile(file, 'file');
    expect((await collect(file)).source.status).toBe('error');
  });

  test('suppresses billed children using parent metadata and excludes orphans with a visible warning', async () => {
    const fixture = await directory();
    const parent = await saveSession(fixture.sessions, 'parent', { ledger: ledger('parent') });
    await saveSession(fixture.sessions, 'child', { ledger: ledger('child') });
    await mkdir(join(parent, 'subagents', 'child-worker'), { recursive: true });
    await writeFile(
      join(parent, 'subagents', 'child-worker', 'meta.json'),
      JSON.stringify({
        child_session_id: 'child',
        parent_session_id: 'parent',
        status: 'completed',
        completed_at: null,
        prompt: 'private child prompt',
      }),
    );
    const result = await collect(fixture.sessions, { cache: fixture.cache });
    expect(result.events.map((event) => event.sessionId)).toEqual(['parent']);
    expect(result.source.status).toBe('ready');
    expect(result.warnings).toEqual([]);
    await saveSession(fixture.sessions, 'orphan', { ledger: ledger('orphan'), metadata: { session_kind: 'subagent' } });
    const orphan = await collect(fixture.sessions);
    expect(orphan.events.map((event) => event.sessionId)).toEqual(['parent']);
    expect(orphan.source.status).toBe('partial');
    expect(orphan.warnings.join(' ')).toContain('no readable parent accounting');
  });

  test('subagent resume/fork kinds are never billed independently, and summary parent chains resolve ownership', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'parent', { ledger: ledger('parent') });
    await saveSession(fixture.sessions, 'resume', {
      ledger: ledger('resume'),
      metadata: { session_kind: 'subagent_resume', parent_session_id: 'parent' },
    });
    await saveSession(fixture.sessions, 'fork', {
      ledger: ledger('fork'),
      metadata: { session_kind: 'subagent_fork', parent_session_id: 'resume' },
    });
    const result = await collect(fixture.sessions);
    expect(result.events.map((event) => event.sessionId)).toEqual(['parent']);
    expect(result.source.status).toBe('ready');
    expect(result.warnings).toEqual([]);
  });

  test('forks canonicalize inherited native turn identities, including nested copies and missing parents', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'parent', { ledger: ledger('parent') });
    const child = await saveSession(fixture.sessions, 'fork', {
      ledger: ledger('fork', [turn(1), turn(2)]),
      metadata: { parent_session_id: 'parent', forked_at: '2026-09-28T05:55:12.000Z' },
    });
    await saveSession(fixture.sessions, 'nested', {
      ledger: ledger('nested', [turn(1), turn(2), turn(3)]),
      metadata: { parent_session_id: 'fork', forked_at: '2026-09-28T05:55:13.000Z' },
    });
    const result = await collect(fixture.sessions, { cache: fixture.cache });
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.sessionId).sort()).toEqual(['fork', 'nested', 'parent']);
    expect(result.files.every((file) => !file.parentId && !file.forkedAt)).toBe(true);
    expect((await collect(fixture.sessions, { cache: fixture.cache })).events).toEqual(result.events);
    await rm(join(fixture.sessions, encodeURIComponent('/work/app'), 'parent'), { recursive: true });
    const absent = await collect(fixture.sessions);
    expect(absent.events.find((event) => event.sessionId === 'parent')?.id).toBe(
      result.events.find((event) => event.sessionId === 'parent')?.id,
    );
    // Corrections change accounting, while the inherited owner identity stays.
    await writeFile(
      join(child, 'usage.json'),
      JSON.stringify(ledger('fork', [turn(1, usage({ outputTokens: 120 })), turn(2)])),
    );
    expect((await collect(fixture.sessions)).events.find((event) => event.sessionId === 'parent')?.id).toBe(
      absent.events.find((event) => event.sessionId === 'parent')?.id,
    );
  });

  test('native parent turn matching handles a fork cutoff timestamp tie without claiming the next turn', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'parent', { ledger: ledger('parent') });
    await saveSession(fixture.sessions, 'fork', {
      ledger: ledger('fork', [turn(1), turn(2, { endedAt: turn(1).endedAt })]),
      metadata: { parent_session_id: 'parent', forked_at: turn(1).endedAt },
    });
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.sessionId).sort()).toEqual(['fork', 'parent']);
  });

  test('the original owner beats a stale fork snapshot after a downward accounting correction', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'parent', {
      ledger: ledger('parent', [turn(1, usage({ outputTokens: 90, costUsdTicks: 100000000 }))]),
    });
    await saveSession(fixture.sessions, 'fork', {
      ledger: ledger('fork'),
      metadata: { parent_session_id: 'parent', forked_at: '2026-09-28T05:55:12Z' },
    });
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ sessionId: 'parent', outputTokens: 90, reportedCostUsd: 0.01 });
  });

  test('per-model cost completeness, cache creation, and bounded reasoning are preserved', async () => {
    const fixture = await directory();
    const models = {
      'grok-4.7-build-fast': { ...counters, cacheCreationTokens: 1000, reasoningTokens: 1000 },
      'grok-4.7-build': { inputTokens: 100, outputTokens: 10, cachedReadTokens: 20, modelCalls: 1 },
    };
    await saveSession(fixture.sessions, 'models', {
      ledger: ledger('models', [turn(1, { modelUsage: models })]),
    });
    const events = (await collect(fixture.sessions)).events;
    expect(events).toHaveLength(2);
    const fast = events.find((event) => event.model === 'grok-4.7-build-fast');
    expect(fast).toMatchObject({ inputTokens: 14059, cacheWriteTokens: 1000, reasoningTokens: 104, costKnown: true });
    const other = events.find((event) => event.model === 'grok-4.7-build');
    expect(other).toMatchObject({ inputTokens: 80, outputTokens: 10, requests: 1, costKnown: false });
    expect(other?.reportedCostUsd).toBeUndefined();
  });

  test.each(['costIsPartial', 'usageIsIncomplete'] as const)(
    'native %s flags use model completeness and whole-turn usage completeness',
    async (flag) => {
      const fixture = await directory();
      await saveSession(fixture.sessions, 'partial-model', {
        ledger: ledger('partial-model', [turn(1, usage({ [flag]: true }))]),
      });
      await saveSession(fixture.sessions, 'partial-turn', {
        ledger: ledger('partial-turn', [turn(1, { [flag]: true })]),
      });
      await saveSession(fixture.sessions, 'complete', {
        ledger: ledger('complete', [turn(1, usage({ [flag]: false }))]),
      });
      await saveSession(fixture.sessions, 'invalid-flag', {
        ledger: ledger('invalid-flag', [turn(1, usage({ [flag]: 'false' }))]),
      });
      const result = await collect(fixture.sessions);
      expect(result.events).toHaveLength(4);
      expect(
        result.events
          .filter((event) => event.sessionId === 'partial-model')
          .every(
            (event) =>
              event.inputTokens === 15059 &&
              !event.costKnown &&
              event.costUsd === 0 &&
              event.reportedCostUsd === undefined,
          ),
      ).toBe(true);
      expect(result.events.find((event) => event.sessionId === 'partial-turn')?.costKnown).toBe(
        flag === 'costIsPartial',
      );
      expect(result.events.find((event) => event.sessionId === 'invalid-flag')?.costKnown).toBe(false);
      expect(result.events.find((event) => event.sessionId === 'complete')?.costKnown).toBe(true);
    },
  );

  test('mixed-model partial cost preserves complete model prices and aggregate fallback requires complete cost', async () => {
    const fixture = await directory();
    await saveSession(fixture.sessions, 'mixed', {
      ledger: ledger('mixed', [
        turn(1, {
          costIsPartial: true,
          modelUsage: {
            'grok-4.7-build-fast': { ...counters, costIsPartial: false },
            'grok-4.7-build': { ...counters, costIsPartial: true },
          },
        }),
      ]),
    });
    await saveSession(fixture.sessions, 'aggregate', {
      ledger: ledger('aggregate', [turn(1, { ...counters, costIsPartial: true, modelUsage: undefined })]),
    });
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(3);
    expect(
      result.events.find((event) => event.sessionId === 'mixed' && event.model === 'grok-4.7-build-fast')?.costKnown,
    ).toBe(true);
    expect(
      result.events.find((event) => event.sessionId === 'mixed' && event.model === 'grok-4.7-build')?.reportedCostUsd,
    ).toBeUndefined();
    expect(result.events.find((event) => event.sessionId === 'aggregate')?.costKnown).toBe(false);
  });

  test('collectUsage integrates Grok home/session roots, deduplicated source counts, global indices, and native pricing', async () => {
    const fixture = await directory();
    const secondRoot = join(fixture.root, 'second', 'sessions');
    await saveSession(fixture.sessions, 'shared', { ledger: ledger('shared') });
    await saveSession(secondRoot, 'second', { ledger: ledger('second') });
    await saveSession(secondRoot, 'shared', { ledger: ledger('shared') });
    const result = await Effect.runPromise(
      collectUsage({
        home: fixture.root,
        claudeDirs: [],
        codexDirs: [],
        piDirs: [],
        grokDirs: [fixture.root, secondRoot],
      }).pipe(Effect.provide(BunServices.layer)),
    );
    expect(result.events).toHaveLength(2);
    expect(result.sources.map((source) => source.harness)).toEqual(['grok', 'grok']);
    expect(result.sources.reduce((sum, source) => sum + source.events, 0)).toBe(2);
    expect(result.sources.map((source) => source.status)).toEqual(['ready', 'ready']);
    expect(result.events.every((event) => event.costKnown && event.reportedCostUsd === 0.02673624)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('bounds oversized legacy records, skips nested symlinks, and retains the next valid accounting row', async () => {
    const fixture = await directory();
    const session = await saveSession(fixture.sessions, 'bounded', { updates: [] });
    const log = join(session, 'updates.jsonl');
    await writeFile(log, `${'x'.repeat(33 * 1024 * 1024)}\n${JSON.stringify(update())}\n`);
    await symlink(session, join(fixture.sessions, encodeURIComponent('/work/app'), 'linked-session'));
    const result = await collect(fixture.sessions);
    expect(result.events).toHaveLength(1);
    expect(result.source.files).toBe(1);
    expect(result.source.status).toBe('partial');
    expect(result.warnings.join(' ')).toContain('1 malformed');
  });
});
