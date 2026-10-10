import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import { collectUsage } from '../../src/lib/server/usage';
import { readT3Metadata } from '../../src/lib/server/usage/t3';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-t3-'));
  temporary.push(home);
  const dataDirectory = join(home, '.t3', 'userdata');
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, 'environment-id'), 'environment:enceladus\n');
  const database = new Database(join(dataDirectory, 'statev2.sqlite'));
  database.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE projection_thread_messages (text TEXT);
    INSERT INTO projection_thread_messages VALUES ('private-prompt private-reply token-secret');
  `);
  return { home, dataDirectory, database };
};
const bind = (
  database: Database,
  {
    nativeId = 'test-session',
    driver = 'claudeAgent',
    threadId = 'thread:original',
    title = 'Make sessions useful',
    projectName = 'Token tracker',
    workspaceRoot = '/work/token-tracker',
    worktreePath = '/work/token-tracker-worktree',
    deletedAt = null,
  }: {
    nativeId?: string;
    driver?: string;
    threadId?: string;
    title?: string;
    projectName?: string;
    workspaceRoot?: string;
    worktreePath?: string;
    deletedAt?: string | null;
  } = {},
) => {
  database
    .query('INSERT OR REPLACE INTO projection_projects VALUES (?, ?, ?)')
    .run('project', projectName, workspaceRoot);
  database
    .query('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)')
    .run(
      threadId,
      'project',
      title,
      deletedAt,
      JSON.stringify({ worktreePath, prompt: 'private-prompt', token: 'token-secret' }),
    );
  database.query('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run(
    `pending:run:${threadId}`,
    threadId,
    '2026-10-10',
    JSON.stringify({
      nativeThreadRef: { nativeId, driver, strength: 'strong' },
      nativeMetadata: { credentials: 'token-secret', response: 'private-reply' },
    }),
  );
};
const read = (home: string, options: { dataDirectory?: string; url?: string } = {}) =>
  Effect.runPromise(readT3Metadata({ home, ...options }).pipe(Effect.provide(BunServices.layer)));

describe('T3 session metadata', () => {
  test('uses native harness IDs, exact drivers, and environment-scoped web URLs without reading conversations', async () => {
    const { home, database, dataDirectory } = await fixture();
    bind(database);
    bind(database, { nativeId: 'test-session', driver: 'codex', threadId: 'thread:codex' });
    bind(database, { nativeId: 'grok-session', driver: 'grok', threadId: 'thread:grok' });
    bind(database, { nativeId: 'pi-session', driver: 'pi', threadId: 'thread:pi' });
    database.close();
    const before = await stat(join(dataDirectory, 'statev2.sqlite'));
    const metadata = await read(home, { url: 'https://app.t3.codes' });
    expect(metadata.get('claude:test-session')).toEqual({
      sessionTitle: 'Make sessions useful',
      projectName: 'Token tracker',
      t3ThreadId: 'thread:original',
      t3ThreadUrl: 'https://app.t3.codes/environment%3Aenceladus/thread%3Aoriginal',
      repositoryPaths: ['/work/token-tracker-worktree', '/work/token-tracker'],
    });
    expect(metadata.get('codex:test-session')?.t3ThreadId).toBe('thread:codex');
    expect(metadata.get('grok:grok-session')?.t3ThreadId).toBe('thread:grok');
    expect(metadata.get('pi:pi-session')?.t3ThreadId).toBe('thread:pi');
    expect(metadata.has('claude:pending:run:thread:original')).toBe(false);
    expect(JSON.stringify([...metadata.values()])).not.toMatch(/private-prompt|private-reply|token-secret/);
    expect((await stat(join(dataDirectory, 'statev2.sqlite'))).mtimeMs).toBe(before.mtimeMs);
  });

  test('deleted threads, malformed bindings, and unsupported drivers do not invent thread matches', async () => {
    const { home, database } = await fixture();
    bind(database, { nativeId: 'deleted', deletedAt: '2026-10-10' });
    bind(database, { nativeId: 'unsupported', driver: 'acpRegistry', threadId: 'thread:acp' });
    bind(database, { nativeId: 'valid', threadId: 'thread:valid', projectName: 'No project' });
    database
      .query('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)')
      .run('broken', 'thread:valid', '2026-10-10', '{invalid-json');
    database.close();
    const metadata = await read(home);
    expect([...metadata.keys()]).toEqual(['claude:deleted', 'claude:valid']);
    expect(metadata.get('claude:deleted')).toEqual({
      t3ThreadId: 'thread:original',
      t3ThreadUrl: '',
      repositoryPaths: [],
    });
    expect(metadata.get('claude:valid')?.projectName).toBeUndefined();
  });

  test('missing, corrupt, and future databases fail open without creating files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'token-tracker-no-t3-'));
    temporary.push(home);
    expect((await read(home)).size).toBe(0);
    expect(await readdir(home)).toEqual([]);
    const { home: corruptHome, database, dataDirectory } = await fixture();
    database.close();
    await writeFile(join(dataDirectory, 'statev2.sqlite'), 'broken sqlite');
    expect((await read(corruptHome)).size).toBe(0);
    const future = new Database(join(dataDirectory, 'state.sqlite'));
    future.exec('CREATE TABLE future_metadata (id TEXT)');
    future.close();
    expect((await read(corruptHome)).size).toBe(0);
  });

  test('configuration targets a custom instance and rejects credential-bearing or unsafe URLs', async () => {
    const { home, database, dataDirectory } = await fixture();
    bind(database);
    database.close();
    const custom = await read('/unrelated/home', { dataDirectory, url: 'https://t3.example.test/app/' });
    expect(custom.get('claude:test-session')?.t3ThreadUrl).toBe(
      'https://t3.example.test/app/environment%3Aenceladus/thread%3Aoriginal',
    );
    for (const url of ['https://user:secret@example.test', 'javascript:alert(1)', 'https://example.test/?token=secret'])
      expect((await read(home, { url })).get('claude:test-session')?.t3ThreadUrl).toBeUndefined();
    await rm(join(dataDirectory, 'environment-id'));
    const missingIdentity = (await read(home)).get('claude:test-session');
    expect(missingIdentity?.sessionTitle).toBe('Make sessions useful');
    expect(missingIdentity?.t3ThreadUrl).toBeUndefined();
  });

  test('legacy runtime cursors remain readable alongside newer bindings', async () => {
    const { home, database } = await fixture();
    bind(database);
    database.exec(`
      CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, worktree_path TEXT);
      CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
      INSERT INTO projection_threads VALUES ('legacy', 'project', 'Legacy title', NULL);
      INSERT INTO provider_session_runtime VALUES ('legacy', 'codex', '{"threadId":"legacy-session"}');
      INSERT INTO provider_session_runtime VALUES ('legacy', 'claude', '{"sessionId":"test-session"}');
    `);
    database.close();
    const metadata = await read(home);
    expect(metadata.get('codex:legacy-session')?.sessionTitle).toBe('Legacy title');
    expect(metadata.get('claude:test-session')?.sessionTitle).toBe('Make sessions useful');
  });

  test.each([
    ['same database', 0],
    ['legacy state.sqlite', 0],
    ['same database', 19_999],
    ['legacy state.sqlite', 19_999],
  ] as const)('V2 tombstones clear stale links from %s with %d additional deletions', async (location, additional) => {
    const { home, database, dataDirectory } = await fixture();
    bind(database, { deletedAt: '2026-10-10' });
    if (additional)
      database
        .query(`
        WITH RECURSIVE n(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM n WHERE x < ?)
        INSERT INTO orchestration_v2_projection_threads
        SELECT 'deleted-' || x, 'project', 'Deleted thread', '2026-10-10', '{}' FROM n
      `)
        .run(additional);
    const legacy = location === 'same database' ? database : new Database(join(dataDirectory, 'state.sqlite'));
    legacy.exec(`
        CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, deleted_at TEXT);
        CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
        CREATE TABLE projection_thread_sessions (thread_id TEXT, provider_name TEXT, provider_thread_id TEXT, provider_session_id TEXT);
        INSERT INTO projection_threads VALUES ('thread:original', 'project', 'Stale active title', NULL);
        INSERT INTO projection_threads VALUES ('thread:still-live', 'project', 'Still live title', NULL);
        INSERT INTO projection_threads VALUES ('legacy:deleted', 'project', 'Deleted legacy title', '2026-10-10');
        INSERT INTO provider_session_runtime VALUES ('thread:original', 'claude', '{"sessionId":"test-session"}');
        INSERT INTO provider_session_runtime VALUES ('thread:still-live', 'codex', '{"threadId":"live-session"}');
        INSERT INTO provider_session_runtime VALUES ('legacy:deleted', 'codex', '{"threadId":"legacy-deleted-session"}');
        INSERT INTO projection_thread_sessions VALUES ('thread:original', 'codex', 'deleted-secondary-session', NULL);
      `);
    if (legacy !== database) legacy.close();
    database.close();
    const metadata = await read(home);
    expect(metadata.get('claude:test-session')).toEqual({
      t3ThreadId: 'thread:original',
      t3ThreadUrl: '',
      repositoryPaths: [],
    });
    expect(metadata.get('codex:deleted-secondary-session')).toEqual({
      t3ThreadId: 'thread:original',
      t3ThreadUrl: '',
      repositoryPaths: [],
    });
    expect(metadata.get('codex:legacy-deleted-session')).toEqual({
      t3ThreadId: 'legacy:deleted',
      t3ThreadUrl: '',
      repositoryPaths: [],
    });
    if (additional) expect(metadata.has('codex:live-session')).toBe(false);
    else expect(metadata.get('codex:live-session')?.t3ThreadId).toBe('thread:still-live');
  });

  test.each(['statev2.sqlite', 'state.sqlite'])(
    'legacy-only deletion clears previously discovered links in %s',
    async (filename) => {
      const { home, database, dataDirectory } = await fixture();
      const legacy = filename === 'statev2.sqlite' ? database : new Database(join(dataDirectory, filename));
      legacy.exec(`
        CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, deleted_at TEXT);
        CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
        CREATE TABLE projection_thread_sessions (thread_id TEXT, provider_name TEXT, provider_thread_id TEXT, provider_session_id TEXT);
        INSERT INTO projection_threads VALUES ('legacy', 'project', 'Legacy title', NULL);
        INSERT INTO provider_session_runtime VALUES ('legacy', 'codex', '{"threadId":"legacy-session"}');
        INSERT INTO projection_thread_sessions VALUES ('legacy', 'claude', NULL, 'legacy-secondary');
      `);
      const before = await read(home);
      expect(before.get('codex:legacy-session')?.t3ThreadUrl).toBe(
        'https://app.t3.codes/environment%3Aenceladus/legacy',
      );
      expect(before.get('claude:legacy-secondary')?.t3ThreadUrl).toBe(
        'https://app.t3.codes/environment%3Aenceladus/legacy',
      );
      legacy.exec("UPDATE projection_threads SET deleted_at = '2026-10-10'");
      if (legacy !== database) legacy.close();
      database.close();
      const after = await read(home);
      for (const key of ['codex:legacy-session', 'claude:legacy-secondary']) {
        expect(after.get(key)).toEqual({ t3ThreadId: 'legacy', t3ThreadUrl: '', repositoryPaths: [] });
      }
    },
  );

  test('warm collection refreshes titles and resolves attached Git repos while preserving cwd and accounting', async () => {
    const { home, database } = await fixture();
    const scratch = join(home, '.t3', 'scratch', 'unhelpful-project-name');
    const workspaceRoot = join(home, 'projects', 'token-tracker');
    await mkdir(join(workspaceRoot, '.git'), { recursive: true });
    await writeFile(
      join(workspaceRoot, '.git', 'config'),
      '[remote "origin"]\nurl = https://user:secret@github.com/davis7dotsh/token-tracker.git\n',
    );
    bind(database, { workspaceRoot, worktreePath: '/missing/worktree' });
    const source = join(home, '.claude', 'projects');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T00:00:00Z',
        cwd: scratch,
        sessionId: 'test-session',
        message: {
          id: 'message',
          model: 'claude-fable-5-1',
          usage: { input_tokens: 100, output_tokens: 10 },
          content: 'private-reply',
        },
      }),
    );
    let rawReads = 0;
    const cacheDirectory = join(home, 'cache');
    const collect = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* collectUsage({ home, cacheDirectory, codexDirs: [], piDirs: [], grokDirs: [] }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stream: (...args) => {
                rawReads++;
                return fs.stream(...args);
              },
            }),
          );
        }).pipe(Effect.provide(BunServices.layer)),
      );
    const first = await collect();
    expect(first.events[0]).toMatchObject({
      project: scratch,
      repository: 'github.com/davis7dotsh/token-tracker',
      sessionTitle: 'Make sessions useful',
      projectName: 'Token tracker',
      inputTokens: 100,
      outputTokens: 10,
    });
    database.exec(
      "UPDATE orchestration_v2_projection_threads SET title = 'Updated thread title'; UPDATE projection_projects SET title = 'Renamed project'",
    );
    const warm = await collect();
    database.exec('BEGIN EXCLUSIVE');
    try {
      const unavailable = await collect();
      // The sync store must treat this fallback as an unavailable binding,
      // preserving its previously saved attached remote (covered over RPC).
      expect(unavailable.events[0]).toMatchObject({ repository: null, project: scratch });
      expect(unavailable.events[0].t3ThreadId).toBeUndefined();
      expect(unavailable.events[0].inputTokens).toBe(first.events[0].inputTokens);
    } finally {
      database.exec('ROLLBACK');
    }
    database.close();
    expect(rawReads).toBe(1);
    expect(warm.events[0]).toEqual({
      ...first.events[0],
      sessionTitle: 'Updated thread title',
      projectName: 'Renamed project',
    });
    const [cached] = await readdir(cacheDirectory);
    const cache = await readFile(join(cacheDirectory, cached), 'utf8');
    expect(cache).not.toMatch(/Updated thread title|Make sessions useful|private-reply|secret/);
    expect(JSON.stringify(warm)).not.toMatch(/private-reply|secret|repositoryPaths/);
    await mkdir(join(scratch, '.git'), { recursive: true });
    await writeFile(
      join(scratch, '.git', 'config'),
      '[remote "origin"]\nurl = git@github.com:davis7dotsh/actual-working-repo.git\n',
    );
    expect((await collect()).events[0].repository).toBe('github.com/davis7dotsh/actual-working-repo');
    expect(rawReads).toBe(1);
    const deleted = new Database(join(home, '.t3', 'userdata', 'statev2.sqlite'));
    deleted.exec("UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-10-10'");
    deleted.close();
    expect((await collect()).events[0]).toMatchObject({ t3ThreadId: 'thread:original', t3ThreadUrl: '' });
    expect(rawReads).toBe(1);
  });
});
