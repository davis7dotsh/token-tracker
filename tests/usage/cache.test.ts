import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import { collectUsage } from '../../src/lib/server/usage';
import {
  claudeParser,
  codexParser,
  parseClaude,
  parseCodex,
  parsePi,
  piParser,
} from '../../src/lib/server/usage/parsers';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'token-tracker-collection-cache-'));
  temporary.push(path);
  return path;
};
const claudeRecord = (id: string, outputTokens = 10) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-01T00:00:00Z',
    cwd: '/work/app',
    sessionId: 'test-session',
    message: {
      id,
      model: 'claude-fable-5-1',
      usage: { input_tokens: 100, output_tokens: outputTokens },
      content: 'private response',
    },
  });

describe('streaming collection and durable metadata cache', () => {
  test.each([
    ['claude.jsonl', claudeParser, parseClaude],
    ['codex-modern.jsonl', codexParser, parseCodex],
    ['codex-legacy.jsonl', codexParser, parseCodex],
    ['pi.jsonl', piParser, parsePi],
  ] as const)('chunk boundaries preserve %s accounting and finalization', async (fixture, makeParser, parse) => {
    const contents = await readFile(join(import.meta.dir, 'testdata', fixture), 'utf8');
    const parser = makeParser(fixture);
    for (let offset = 0; offset < contents.length; offset += 7) parser.push(contents.slice(offset, offset + 7));
    expect(parser.finish()).toEqual(parse(contents, fixture));
  });

  test('oversized records are bounded and skipped while incomplete final records remain retryable', () => {
    const parser = claudeParser('session.jsonl');
    const large = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 33; index++) parser.push(large);
    parser.push(`\n${claudeRecord('valid')}\n{"type":"assistant"`);
    const parsed = parser.finish();
    expect(parsed.malformed).toBe(1);
    expect(parsed.events.map((entry) => entry.event.id)).toEqual(['claude:message:valid:']);
  });

  test('warm collection skips raw logs, invalidates appends and same-size corrections, and never caches conversation content', async () => {
    const home = await directory();
    const source = join(home, 'claude', 'projects');
    const cacheDirectory = join(home, 'cache');
    const log = join(source, 'one.jsonl');
    await mkdir(source, { recursive: true });
    await writeFile(log, `${claudeRecord('one')}\n`);
    let rawReads = 0;
    const collect = (useCache = true) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* collectUsage({
            home,
            claudeDirs: [join(home, 'claude')],
            codexDirs: [],
            piDirs: [],
            ...(useCache ? { cacheDirectory } : {}),
          }).pipe(
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
    expect(rawReads).toBe(1);
    const warm = await collect();
    expect(warm).toEqual(first);
    expect(rawReads).toBe(1);
    const [cachedName] = await readdir(cacheDirectory);
    const cachedPath = join(cacheDirectory, cachedName);
    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(cachedPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(cachedPath, 'utf8')).not.toContain('private response');
    await appendFile(log, `${claudeRecord('two')}\n`);
    expect((await collect()).events).toHaveLength(2);
    expect(rawReads).toBe(2);
    const before = await stat(log);
    const contents = await readFile(log, 'utf8');
    await writeFile(log, contents.replace('"output_tokens":10', '"output_tokens":30'));
    await utimes(log, before.atime, before.mtime);
    const corrected = await collect();
    expect(corrected.events[0].outputTokens).toBe(30);
    expect(rawReads).toBe(3);
    await writeFile(cachedPath, '{broken cache');
    expect((await collect()).events).toEqual(corrected.events);
    expect(rawReads).toBe(4);
    const beforeManual = await readFile(cachedPath, 'utf8');
    expect((await collect(false)).events).toEqual(corrected.events);
    expect(rawReads).toBe(5);
    expect(await readFile(cachedPath, 'utf8')).toBe(beforeManual);
  });

  test.skipIf(process.platform === 'win32')(
    'source inventory follows the configured root alias and skips nested symlinks and special files',
    async () => {
      const home = await directory();
      const root = join(home, 'actual-projects');
      const source = join(home, 'claude', 'projects');
      const outside = join(home, 'outside');
      await mkdir(join(root, 'nested'), { recursive: true });
      await mkdir(join(home, 'claude'));
      await mkdir(outside);
      await writeFile(join(root, 'first.JSONL'), `${claudeRecord('first')}\n`);
      await writeFile(join(root, 'nested', 'second.jsonl'), `${claudeRecord('second')}\n`);
      await writeFile(join(root, 'ignored.txt'), `${claudeRecord('ignored')}\n`);
      await writeFile(join(outside, 'outside.jsonl'), `${claudeRecord('outside')}\n`);
      await symlink(root, source);
      await symlink(outside, join(root, 'linked-directory'));
      await symlink(join(outside, 'outside.jsonl'), join(root, 'linked-file.jsonl'));
      await symlink(join(home, 'missing'), join(root, 'broken-link'));
      const fifo = Bun.spawn(['mkfifo', join(root, 'special.jsonl')], { stdout: 'ignore', stderr: 'ignore' });
      expect(await fifo.exited).toBe(0);
      const result = await Effect.runPromise(
        collectUsage({
          home,
          claudeDirs: [join(home, 'claude')],
          codexDirs: [],
          piDirs: [],
          grokDirs: [],
          museDirs: [],
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect(result.sources[0]).toMatchObject({ files: 2, events: 2, status: 'ready' });
      expect(result.events.map((event) => event.id)).toEqual(['claude:message:first:', 'claude:message:second:']);
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'unreadable nested inventory directories retain partial source diagnostics',
    async () => {
      const home = await directory();
      const root = join(home, 'claude', 'projects');
      const denied = join(root, 'denied');
      await mkdir(denied, { recursive: true });
      await writeFile(join(root, 'readable.jsonl'), `${claudeRecord('readable')}\n`);
      await chmod(denied, 0);
      try {
        const result = await Effect.runPromise(
          collectUsage({
            home,
            claudeDirs: [join(home, 'claude')],
            codexDirs: [],
            piDirs: [],
            grokDirs: [],
            museDirs: [],
          }).pipe(Effect.provide(BunServices.layer)),
        );
        expect(result.events).toHaveLength(1);
        expect(result.sources[0]).toMatchObject({ files: 1, events: 1, status: 'partial' });
        expect(result.sources[0].error).toBe(
          'Skipped 0 malformed records; 0 files and 1 directories could not be read.',
        );
        expect(result.warnings).toContain(`claude: ${result.sources[0].error}`);
      } finally {
        await chmod(denied, 0o700);
      }
    },
  );
});
