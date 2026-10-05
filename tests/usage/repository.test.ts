import { afterEach, expect, test } from 'bun:test';
import { BunServices } from '@effect/platform-bun';
import { Deferred, Effect, Fiber, FileSystem } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeRepositoryResolver, resolveRepository } from '../../src/lib/server/usage/repository';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const temporary = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'token-tracker-repository-'));
  directories.push(directory);
  return directory;
};
const write = async (filename: string, contents: string) => {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, contents);
};
const lookup = (cwd: string) => Effect.runPromise(resolveRepository(cwd).pipe(Effect.provide(BunServices.layer)));
const trackedLookup = async (cwd: string, home: string, platform: NodeJS.Platform = 'darwin') => {
  const operations: { operation: string; path: string }[] = [];
  const record = (operation: string, path: string) => operations.push({ operation, path });
  const repository = await Effect.runPromise(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      return yield* resolveRepository(cwd, { platform, home }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...filesystem,
          stat: (filename) => {
            record('stat', filename);
            return filesystem.stat(filename);
          },
          readFileString: (filename, encoding) => {
            record('readFileString', filename);
            return filesystem.readFileString(filename, encoding);
          },
          open: (filename, options) => {
            record('open', filename);
            return filesystem.open(filename, options);
          },
          readLink: (filename) => {
            record('readLink', filename);
            return filesystem.readLink(filename);
          },
          realPath: (filename) => {
            record('realPath', filename);
            return filesystem.realPath(filename);
          },
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
  return { repository, operations };
};
const fifo = async (filename: string) => {
  await mkdir(dirname(filename), { recursive: true });
  const process = Bun.spawn(['mkfifo', filename], { stdout: 'ignore', stderr: 'ignore' });
  expect(await process.exited).toBe(0);
};

test('guarded metadata preserves SSH, HTTPS and linked-worktree repository identity', async () => {
  const directory = await temporary();
  await write(join(directory, 'ssh/.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await write(
    join(directory, 'https/.git/config'),
    '[remote "origin"]\n url = https://user:password@github.com/Davis7/App.git\n',
  );
  await write(join(directory, 'ssh/.git/worktrees/feature/commondir'), '../..\n');
  await write(join(directory, 'feature/.git'), 'gitdir: ../ssh/.git/worktrees/feature\n');
  expect(await lookup(join(directory, 'ssh'))).toBe('github.com/davis7/app');
  expect(await lookup(join(directory, 'https'))).toBe('github.com/davis7/app');
  expect(await lookup(join(directory, 'feature'))).toBe('github.com/davis7/app');
});

test('special Git metadata never opens a named pipe or hides a healthy origin', async () => {
  const directory = await temporary();
  await fifo(join(directory, 'pointer/.git'));
  await fifo(join(directory, 'common/.git/commondir'));
  await write(join(directory, 'common/.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await fifo(join(directory, 'config/.git/config'));
  expect(await lookup(join(directory, 'pointer'))).toBeNull();
  expect(await lookup(join(directory, 'common'))).toBe('github.com/davis7/app');
  expect(await lookup(join(directory, 'config'))).toBe(`local:${join(directory, 'config')}`);
});

test('oversized Git metadata is skipped before reading', async () => {
  const directory = await temporary();
  const config = join(directory, '.git/config');
  await write(config, '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await truncate(config, 1_048_577);
  let read = false;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      return yield* resolveRepository(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...filesystem,
          readFileString: (filename, encoding) => {
            if (filename === config) read = true;
            return filesystem.readFileString(filename, encoding);
          },
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
  expect(result).toBe(`local:${directory}`);
  expect(read).toBe(false);
});

test('a stalled optional metadata read is interrupted after three seconds', async () => {
  const directory = await temporary();
  const config = join(directory, '.git/config');
  await write(config, '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  let finalized = false;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      const started = yield* Deferred.make<void>();
      const stalled = {
        ...filesystem,
        readFileString: (filename: string, encoding?: string) =>
          filename === config
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized = true;
                  }),
                ),
              )
            : filesystem.readFileString(filename, encoding),
      };
      const fiber = yield* Effect.forkChild(
        resolveRepository(directory).pipe(Effect.provideService(FileSystem.FileSystem, stalled)),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust('3 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(BunServices.layer)),
  );
  expect(result).toBeNull();
  expect(finalized).toBe(true);
});

test('one collection has a shared metadata deadline and retains completed repository identities', async () => {
  const directory = await temporary();
  const healthy = join(directory, 'healthy');
  const stalledProjects = ['first', 'second', 'third'].map((name) => join(directory, name));
  for (const project of [healthy, ...stalledProjects])
    await write(join(project, '.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  let reads = 0;
  let finalized = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const stalledFiles = new Set(stalledProjects.map((project) => join(project, '.git/config')));
      const guarded = {
        ...filesystem,
        readFileString: (filename: string, encoding?: string) => {
          if (!stalledFiles.has(filename)) return filesystem.readFileString(filename, encoding);
          const started = reads++ === 0 ? firstStarted : secondStarted;
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          );
        },
      };
      const resolve = makeRepositoryResolver();
      const withinBudget = (project: string) =>
        resolve(project).pipe(Effect.provideService(FileSystem.FileSystem, guarded));
      const identities = new Map<string, string | null>();
      identities.set(healthy, yield* withinBudget(healthy));
      const first = yield* Effect.forkChild(withinBudget(stalledProjects[0]));
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust('3 seconds');
      identities.set(stalledProjects[0], yield* Fiber.join(first));
      const second = yield* Effect.forkChild(withinBudget(stalledProjects[1]));
      yield* Deferred.await(secondStarted);
      yield* TestClock.adjust('2 seconds');
      identities.set(stalledProjects[1], yield* Fiber.join(second));
      identities.set(stalledProjects[2], yield* withinBudget(stalledProjects[2]));
      return identities;
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(BunServices.layer)),
  );
  expect(result.get(healthy)).toBe('github.com/davis7/app');
  for (const project of stalledProjects) expect(result.get(project)).toBeNull();
  expect(reads).toBe(2);
  expect(finalized).toBe(2);
});

test('Darwin protected project paths are rejected before any filesystem operation', async () => {
  const home = '/Users/Davis';
  const projects = [
    `${home}/Documents/project`,
    `${home}/DESKTOP/project`,
    `${home}/downloads/project`,
    `${home}/Library/Mobile Documents/com~apple~CloudDocs/project`,
    `${home}/Library/CloudStorage/iCloud Drive/project`,
    '/users/davis/dOcUmEnTs/project',
    `/System/Volumes/Data${home}/Documents/project`,
    '/SYSTEM/VOLUMES/DATA/users/davis/downloads/project',
    `${home}/Developer/../Documents/project`,
  ];
  for (const project of projects) {
    const result = await trackedLookup(project, home);
    expect(result.repository, project).toBeNull();
    expect(result.operations, project).toEqual([]);
  }
});

test('Darwin blocks protected cwd symlinks and intermediate symlinks before metadata access', async () => {
  const home = await temporary();
  const privateProject = join(home, 'Documents/project');
  await write(join(privateProject, '.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await mkdir(join(home, 'Developer'), { recursive: true });
  await symlink(privateProject, join(home, 'Developer/project-alias'));
  await symlink('../Documents', join(home, 'Developer/folder-alias'));
  for (const project of [join(home, 'Developer/project-alias'), join(home, 'Developer/folder-alias/project')]) {
    const result = await trackedLookup(project, home);
    expect(result.repository).toBeNull();
    expect(result.operations.filter(({ operation }) => operation !== 'readLink')).toEqual([]);
    expect(result.operations.some(({ path }) => path.startsWith(join(home, 'Documents')))).toBe(false);
  }
});

test('Darwin resolves physical home aliases without touching their protected contents', async () => {
  const directory = await temporary();
  const physicalHome = join(directory, 'actual-home');
  const home = join(directory, 'home-alias');
  await write(
    join(physicalHome, 'Documents/project/.git/config'),
    '[remote "origin"]\n url = git@github.com:Davis7/App.git\n',
  );
  await symlink(physicalHome, home);
  const result = await trackedLookup(join(physicalHome, 'Documents/project'), home);
  expect(result.repository).toBeNull();
  expect(result.operations.filter(({ operation }) => operation !== 'readLink')).toEqual([]);
  expect(result.operations.some(({ path }) => path.startsWith(join(physicalHome, 'Documents')))).toBe(false);
});

test('Darwin rejects protected Git pointers, common directories and metadata symlinks before following them', async () => {
  const home = await temporary();
  const protectedGit = join(home, 'Documents/repository/.git');
  await write(join(protectedGit, 'config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await write(join(protectedGit, 'commondir'), '.\n');
  const developer = join(home, 'Developer');
  await mkdir(developer, { recursive: true });
  await symlink(protectedGit, join(developer, 'metadata-alias'));
  const cases = [
    { name: 'git-symlink', filename: '.git', target: protectedGit },
    { name: 'git-pointer', filename: '.git', contents: `gitdir: ${protectedGit}\n` },
    { name: 'git-pointer-alias', filename: '.git', contents: 'gitdir: ../metadata-alias\n' },
    { name: 'common-pointer', filename: '.git/commondir', contents: `${protectedGit}\n` },
    { name: 'common-pointer-alias', filename: '.git/commondir', contents: '../../metadata-alias\n' },
    { name: 'common-symlink', filename: '.git/commondir', target: join(protectedGit, 'commondir') },
    { name: 'config-symlink', filename: '.git/config', target: join(protectedGit, 'config') },
  ];
  for (const scenario of cases) {
    const project = join(developer, scenario.name);
    const filename = join(project, scenario.filename);
    await mkdir(dirname(filename), { recursive: true });
    if (scenario.target) await symlink(scenario.target, filename);
    else if (scenario.contents !== undefined) await write(filename, scenario.contents);
    const result = await trackedLookup(project, home);
    expect(result.repository, scenario.name).toBeNull();
    expect(
      result.operations.some(({ path }) => path.startsWith(join(home, 'Documents'))),
      scenario.name,
    ).toBe(false);
    if (scenario.target)
      expect(
        result.operations.some(({ operation, path }) => operation !== 'readLink' && path === filename),
        scenario.name,
      ).toBe(false);
    expect(
      result.operations.some(({ operation }) => operation === 'realPath'),
      scenario.name,
    ).toBe(false);
  }
});

test('Darwin keeps safe repository symlinks, metadata links and worktrees grouped', async () => {
  const home = await temporary();
  const main = join(home, 'Developer/main');
  await write(join(main, '.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  await write(join(main, '.git/worktrees/feature/commondir'), '../..\n');
  await write(join(home, 'Developer/feature/.git'), 'gitdir: ../main/.git/worktrees/feature\n');
  await symlink(main, join(home, 'Developer/main-alias'));
  await mkdir(join(home, 'Developer/git-alias'), { recursive: true });
  await symlink(join(main, '.git'), join(home, 'Developer/git-alias/.git'));
  await mkdir(join(home, 'Developer/config-alias/.git'), { recursive: true });
  await symlink(join(main, '.git/config'), join(home, 'Developer/config-alias/.git/config'));
  await write(join(home, 'Developer/common-alias/.git/commondir-target'), '../../main/.git\n');
  await symlink('commondir-target', join(home, 'Developer/common-alias/.git/commondir'));
  await write(join(home, 'Documents-backup/.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  for (const project of [
    main,
    'Developer/main-alias',
    'Developer/git-alias',
    'Developer/config-alias',
    'Developer/common-alias',
    'Developer/feature',
    'Documents-backup',
  ]) {
    const filename = project === main ? main : join(home, project);
    const result = await trackedLookup(filename, home);
    expect(result.repository, filename).toBe('github.com/davis7/app');
    expect(result.operations.some(({ operation }) => operation === 'realPath')).toBe(false);
  }
});

test('Linux repositories in Documents retain identity without Darwin path inspections', async () => {
  const home = await temporary();
  const project = join(home, 'Documents/project');
  await write(join(project, '.git/config'), '[remote "origin"]\n url = git@github.com:Davis7/App.git\n');
  const result = await trackedLookup(project, home, 'linux');
  expect(result.repository).toBe('github.com/davis7/app');
  expect(result.operations.some(({ operation }) => operation === 'readLink' || operation === 'realPath')).toBe(false);
});
