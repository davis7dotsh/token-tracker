import { afterEach, expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Effect, FileSystem } from 'effect';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectUsage, type CollectionOptions } from '../../src/lib/server/usage';
import { usageRevision } from '../../src/lib/server/usage/revision';
import { rememberRepositoryDependencies } from '../../src/lib/server/usage/revision-dependencies';
import type { UsageResult } from '../../src/lib/shared/domain';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const temporary = async () => {
  const home = await mkdtemp(join(tmpdir(), 'token-tracker-revision-'));
  homes.push(home);
  return home;
};
const write = async (file: string, contents = '') => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
};
const optionsFor = (home: string): CollectionOptions => ({
  home,
  claudeDirs: [join(home, '.claude')],
  codexDirs: [],
  piDirs: [],
  grokDirs: [],
  museDirs: [],
});
const revision = (options: CollectionOptions, previous?: UsageResult) =>
  Effect.runPromise(usageRevision(options)(previous).pipe(Effect.provide(BunServices.layer)));
const emptyUsage = (): UsageResult => ({ events: [], sources: [], warnings: [], pricingUpdatedAt: '' });

test('unchanged inventories skip file contents and detect append, same-size rewrite with restored mtime, replacement, deletion and nested additions', async () => {
  const home = await temporary();
  const options = optionsFor(home);
  const file = join(home, '.claude/projects/one/events.jsonl');
  const missing = await revision(options);
  await write(file, 'one\n');
  const initial = await revision(options);
  expect(initial).not.toBe(missing);
  expect(await revision(options)).toBe(initial);
  await appendFile(file, 'two\n');
  const appended = await revision(options);
  expect(appended).not.toBe(initial);
  const before = await stat(file);
  await writeFile(file, 'xxx\nyyy\n');
  await utimes(file, before.atime, before.mtime);
  const rewritten = await revision(options);
  expect(rewritten).not.toBe(appended);
  await write(`${file}.replacement`, 'xxx\nyyy\n');
  await rename(`${file}.replacement`, file);
  const replaced = await revision(options);
  expect(replaced).not.toBe(rewritten);
  await write(join(home, '.claude/projects/new/nested/new.jsonl'), '{}\n');
  const added = await revision(options);
  expect(added).not.toBe(replaced);
  await rm(file);
  expect(await revision(options)).not.toBe(added);
});

test('configured root aliases are followed while nested symlinks never import external log changes', async () => {
  const home = await temporary();
  const actual = join(home, 'actual/projects');
  const external = join(home, 'external');
  await write(join(actual, 'one.jsonl'), '{}\n');
  await write(join(external, 'secret.jsonl'), '{}\n');
  await symlink(join(home, 'actual'), join(home, 'alias'));
  await symlink(external, join(actual, 'nested-link'));
  const options = { ...optionsFor(home), claudeDirs: [join(home, 'alias')] };
  const initial = await revision(options);
  await appendFile(join(external, 'secret.jsonl'), 'changed\n');
  expect(await revision(options)).toBe(initial);
  await appendFile(join(actual, 'one.jsonl'), 'changed\n');
  expect(await revision(options)).not.toBe(initial);
});

test.skipIf(Boolean(process.env.CLAUDE_CONFIG_DIR || process.env.XDG_CONFIG_HOME))(
  'new default XDG roots are detected and use the same discovery as collection',
  async () => {
    const home = await temporary();
    const options = { ...optionsFor(home), claudeDirs: undefined };
    const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    const initial = await revision(options);
    await write(join(xdg, 'claude/projects/new.jsonl'), '{}\n');
    expect(await revision(options)).not.toBe(initial);
    const usage = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    expect(usage.sources.some((source) => source.path === join(xdg, 'claude/projects'))).toBe(true);
  },
);

test('Grok summary, ownership, cwd and ledger JSON changes invalidate without reading their contents', async () => {
  const home = await temporary();
  const options = { ...optionsFor(home), grokDirs: [join(home, '.grok')] };
  const files = [
    'group/.cwd',
    'group/session/summary.json',
    'group/session/usage.json',
    'group/session/subagents/child/meta.json',
  ];
  for (const file of files) await write(join(home, '.grok/sessions', file), '{}');
  for (const file of files) {
    const initial = await revision(options);
    await appendFile(join(home, '.grok/sessions', file), '\n');
    expect(await revision(options), file).not.toBe(initial);
  }
});

test('T3 database, WAL, environment identity and URL changes invalidate without querying SQLite', async () => {
  const home = await temporary();
  const options = { ...optionsFor(home), t3DataDirectory: join(home, 't3'), t3Url: 'https://example.test' };
  for (const name of ['statev2.sqlite', 'statev2.sqlite-wal', 'state.sqlite', 'state.sqlite-wal', 'environment-id']) {
    const initial = await revision(options);
    await write(join(home, 't3', name), 'not sqlite; stat only');
    expect(await revision(options), name).not.toBe(initial);
  }
  expect(await revision({ ...options, t3Url: 'https://other.example.test' })).not.toBe(await revision(options));
});

test('collection records Git config, worktree pointer and common-dir dependencies without serializing internal paths', async () => {
  const home = await temporary();
  const project = join(home, 'project');
  const config = join(home, 'main/.git/config');
  await write(config, '[remote "origin"]\n url = git@github.com:owner/first.git\n');
  await write(join(home, 'main/.git/worktrees/feature/commondir'), '../..\n');
  await write(join(project, '.git'), 'gitdir: ../main/.git/worktrees/feature\n');
  const log = await readFile(join(import.meta.dir, 'testdata/claude.jsonl'), 'utf8');
  // The fixture's cwd field drives the actual guarded repository resolver.
  const contents = log
    .split('\n')
    .map((line) => {
      if (!line) return line;
      return JSON.stringify({ ...JSON.parse(line), cwd: project });
    })
    .join('\n');
  await write(join(home, '.claude/projects/one/events.jsonl'), contents);
  const options = optionsFor(home);
  const usage = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
  expect(usage.events.length).toBeGreaterThan(0);
  expect(usage.events[0].repository).toBe('github.com/owner/first');
  expect(JSON.stringify(usage)).not.toContain('commondir');
  let initial = await revision(options, usage);
  await writeFile(config, '[remote "origin"]\n url = git@github.com:owner/other.git\n');
  expect(await revision(options, usage)).not.toBe(initial);
  initial = await revision(options, usage);
  await writeFile(join(home, 'main/.git/worktrees/feature/commondir'), '../../other\n');
  expect(await revision(options, usage)).not.toBe(initial);
  initial = await revision(options, usage);
  await writeFile(join(project, '.git'), 'gitdir: ../another/.git\n');
  expect(await revision(options, usage)).not.toBe(initial);
});

test('repository checks preserve Darwin protected-path guards before stat, content or directory reads', async () => {
  const home = await temporary();
  const privateFile = join(home, 'Documents/project/.git/config');
  await write(privateFile, '[remote "origin"]\n url = git@github.com:owner/private.git\n');
  const alias = join(home, 'Developer/project');
  await mkdir(dirname(alias), { recursive: true });
  await symlink(join(home, 'Documents/project'), alias);
  const usage = emptyUsage();
  rememberRepositoryDependencies(usage, new Set([join(alias, '.git/config')]));
  const operations: string[] = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* Effect.result(
        usageRevision(optionsFor(home), { platform: 'darwin', home })(usage).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readLink: (file) => {
              operations.push(file);
              return fs.readLink(file);
            },
            stat: (file) => {
              operations.push(file);
              return fs.stat(file);
            },
            readFileString: (file, encoding) => {
              operations.push(file);
              return fs.readFileString(file, encoding);
            },
          }),
        ),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(result._tag).toBe('Success');
  expect(operations.some((file) => file.startsWith(join(home, 'Documents')))).toBe(false);
  const guardedRevision = () =>
    Effect.runPromise(
      usageRevision(optionsFor(home), { platform: 'darwin', home })(usage).pipe(Effect.provide(BunServices.layer)),
    );
  const protectedRevision = await guardedRevision();
  expect(await guardedRevision()).toBe(protectedRevision);
  const allowed = join(home, 'Developer/allowed');
  await write(join(allowed, '.git/config'), '[remote "origin"]\n url = git@github.com:owner/allowed.git\n');
  await rm(alias);
  await symlink(allowed, alias);
  expect(await guardedRevision()).not.toBe(protectedRevision);
});

test('a transient repository metadata read retries within the first request without any file-stat change', async () => {
  const { makeLocalUsageSnapshot } = await import('../../src/lib/server/rpc/hub');
  const home = await temporary();
  const project = join(home, 'project');
  const config = join(project, '.git/config');
  await write(config, '[remote "origin"]\n url = git@github.com:owner/recovered.git\n');
  const log = await readFile(join(import.meta.dir, 'testdata/claude.jsonl'), 'utf8');
  const contents = log
    .split('\n')
    .map((line) => (line ? JSON.stringify({ ...JSON.parse(line), cwd: project }) : line))
    .join('\n');
  await write(join(home, '.claude/projects/one/events.jsonl'), contents);
  const options = optionsFor(home);
  const before = await stat(config, { bigint: true });
  let reads = 0;
  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const collect = collectUsage(options).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) => {
            if (file === config && ++reads === 1) return fs.readFileString(join(home, 'transient-missing-file'));
            return fs.readFileString(file, encoding);
          },
        }),
        Effect.provide(BunServices.layer),
      );
      const current = yield* makeLocalUsageSnapshot(collect, (previous) =>
        usageRevision(options)(previous).pipe(Effect.provide(BunServices.layer)),
      );
      return yield* current;
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const after = await stat(config, { bigint: true });
  expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
    before.ino,
    before.size,
    before.mtimeNs,
    before.ctimeNs,
  ]);
  expect(reads).toBe(2);
  expect(snapshot.current.events[0].repository).toBe('github.com/owner/recovered');
});

test('intentional protected and missing repositories stay cacheable', async () => {
  const { resolveRepository } = await import('../../src/lib/server/usage/repository');
  const home = await temporary();
  let failures = 0;
  for (const project of [join(home, 'Documents/project'), join(home, 'Developer/missing')]) {
    expect(
      await Effect.runPromise(
        resolveRepository(project, { home, platform: 'darwin', onFailure: () => failures++ }).pipe(
          Effect.provide(BunServices.layer),
        ),
      ),
    ).toBeNull();
  }
  expect(failures).toBe(0);
});

test('T3 failures report retry state internally and never expose diagnostic metadata keys', async () => {
  const { readT3Metadata } = await import('../../src/lib/server/usage/t3');
  const { queryT3Databases } = await import('../../src/lib/server/usage/t3-database');
  const home = await temporary();
  const dataDirectory = join(home, 't3');
  const filename = join(dataDirectory, 'statev2.sqlite');
  await write(filename, 'not a SQLite database');
  let failures = 0;
  const metadata = await Effect.runPromise(
    readT3Metadata({ home, dataDirectory, onFailure: () => failures++ }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(metadata.size).toBe(0);
  expect(metadata.has('')).toBe(false);
  expect(failures).toBe(1);
  expect(await queryT3Databases({ filenames: [filename], baseUrl: 'https://example.test' })).toEqual([]);
  const options = { ...optionsFor(home), t3DataDirectory: dataDirectory };
  const usage = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
  expect(await revision(options, usage)).not.toBe(await revision(options, usage));
});

test.skipIf(process.getuid?.() === 0)(
  'optional T3 and repository permission failures keep healthy accounting available and retry until observation recovers',
  async () => {
    const { makeLocalUsageSnapshot } = await import('../../src/lib/server/rpc/hub');
    const home = await temporary();
    const dataDirectory = join(home, 't3');
    const identity = join(dataDirectory, 'environment-id');
    const gitDirectory = join(home, 'project/.git');
    const config = join(gitDirectory, 'config');
    await write(identity, 'fixture-environment');
    await write(config, '[remote "origin"]\n url = git@github.com:owner/project.git\n');
    await write(
      join(home, '.claude/projects/one/events.jsonl'),
      await readFile(join(import.meta.dir, 'testdata/claude.jsonl'), 'utf8'),
    );
    const options = { ...optionsFor(home), t3DataDirectory: dataDirectory };
    const usage = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
    rememberRepositoryDependencies(usage, new Set([config]));
    const before = await Promise.all([identity, config].map((file) => stat(file, { bigint: true })));
    await chmod(dataDirectory, 0);
    await chmod(gitDirectory, 0);
    try {
      expect(await revision(options, usage)).not.toBe(await revision(options, usage));
      const current = await Effect.runPromise(
        Effect.gen(function* () {
          const snapshot = yield* makeLocalUsageSnapshot(
            collectUsage(options).pipe(Effect.provide(BunServices.layer)),
            (previous) => usageRevision(options)(previous).pipe(Effect.provide(BunServices.layer)),
          );
          return yield* snapshot;
        }),
      );
      expect(current.current.events.length).toBe(usage.events.length);
      expect(current.current.events.length).toBeGreaterThan(0);
    } finally {
      await chmod(dataDirectory, 0o700);
      await chmod(gitDirectory, 0o700);
    }
    const after = await Promise.all([identity, config].map((file) => stat(file, { bigint: true })));
    expect(after.map((info) => [info.ino, info.size, info.mtimeNs, info.ctimeNs])).toEqual(
      before.map((info) => [info.ino, info.size, info.mtimeNs, info.ctimeNs]),
    );
    expect(await revision(options, usage)).toBe(await revision(options, usage));
  },
);

test('optional T3 observation errors are retryable without requiring a permission-denied platform', async () => {
  const home = await temporary();
  const directory = join(home, 't3-loop');
  await symlink('t3-loop', directory);
  const options = { ...optionsFor(home), t3DataDirectory: directory };
  expect(await revision(options)).not.toBe(await revision(options));
  await rm(directory);
  await mkdir(directory);
  expect(await revision(options)).toBe(await revision(options));
});

test('linked Git metadata invalidates when the external target changes without replacing the symlink', async () => {
  const home = await temporary();
  const project = join(home, 'project');
  const target = join(home, 'shared/git-config');
  const link = join(project, '.git/config');
  await write(target, '[remote "origin"]\n url = git@github.com:owner/first.git\n');
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  const log = await readFile(join(import.meta.dir, 'testdata/claude.jsonl'), 'utf8');
  await write(
    join(home, '.claude/projects/one/events.jsonl'),
    log
      .split('\n')
      .map((line) => (line ? JSON.stringify({ ...JSON.parse(line), cwd: project }) : line))
      .join('\n'),
  );
  const options = optionsFor(home);
  const usage = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
  expect(usage.events[0].repository).toBe('github.com/owner/first');
  const beforeLink = await lstat(link, { bigint: true });
  const initial = await revision(options, usage);
  await writeFile(target, '[remote "origin"]\n url = git@github.com:owner/other.git\n');
  const afterLink = await lstat(link, { bigint: true });
  expect([afterLink.ino, afterLink.size, afterLink.mtimeNs, afterLink.ctimeNs]).toEqual([
    beforeLink.ino,
    beforeLink.size,
    beforeLink.mtimeNs,
    beforeLink.ctimeNs,
  ]);
  expect(await revision(options, usage)).not.toBe(initial);
  const updated = await Effect.runPromise(collectUsage(options).pipe(Effect.provide(BunServices.layer)));
  expect(updated.events[0].repository).toBe('github.com/owner/other');
});

test('linked Git metadata never follows a final symlink into Darwin protected directories', async () => {
  const home = await temporary();
  const target = join(home, 'Documents/private-config');
  const link = join(home, 'Developer/project/.git/config');
  await write(target, '[remote "origin"]\n url = git@github.com:owner/private.git\n');
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  const usage = emptyUsage();
  rememberRepositoryDependencies(usage, new Set([link]));
  const guardedRevision = () =>
    Effect.runPromise(
      usageRevision(optionsFor(home), { platform: 'darwin', home })(usage).pipe(Effect.provide(BunServices.layer)),
    );
  const initial = await guardedRevision();
  await writeFile(target, '[remote "origin"]\n url = git@github.com:owner/changed.git\n');
  expect(await guardedRevision()).toBe(initial);
});
