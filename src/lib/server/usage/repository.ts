import { Clock, Data, Effect, FileSystem, Path, Result } from 'effect';
import { homedir } from 'node:os';

type RepositoryOptions = { platform?: NodeJS.Platform; home?: string };
class RepositoryPathUnavailable extends Data.TaggedError('RepositoryPathUnavailable') {}

// Optional Git grouping must never ask macOS for access to a user's private
// folders. Check names before I/O and resolve symlinks one component at a time:
// realPath/stat would follow an unchecked link into a protected directory.
const makeRepositoryPathResolver = Effect.fn('usage.makeRepositoryPathResolver')(function* (
  cwd: string,
  options: RepositoryOptions,
) {
  const path = yield* Path.Path;
  if ((options.platform ?? process.platform) !== 'darwin') return (file: string) => Effect.succeed(path.resolve(file));
  const fs = yield* FileSystem.FileSystem;
  const home = path.resolve(options.home ?? homedir());
  const canonical = (file: string) =>
    path
      .resolve(file)
      .normalize('NFD')
      .toLowerCase()
      .replace(/^\/system\/volumes\/data(?=\/|$)/, '');
  const protectedNames = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'];
  const roots = protectedNames.map((name) => canonical(path.join(home, name)));
  const blocked = (file: string) => {
    const canonicalFile = canonical(file);
    return roots.some((root) => canonicalFile === root || canonicalFile.startsWith(`${root}/`));
  };
  if (blocked(cwd)) return yield* Effect.fail(new RepositoryPathUnavailable());
  const nonLinks = new Set<string>();
  const safePath = Effect.fn('usage.resolveSafeRepositoryPath')(function* (file: string) {
    let resolved = path.resolve(file);
    for (let links = 0; links < 40; links++) {
      if (blocked(resolved)) return yield* Effect.fail(new RepositoryPathUnavailable());
      let component = path.parse(resolved).root;
      const parts = resolved.slice(component.length).split(path.sep).filter(Boolean);
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        component = path.join(component, parts[index]);
        if (blocked(component)) return yield* Effect.fail(new RepositoryPathUnavailable());
        if (nonLinks.has(component)) continue;
        const link = yield* Effect.result(fs.readLink(component));
        if (Result.isSuccess(link)) {
          resolved = path.resolve(path.dirname(component), link.success, ...parts.slice(index + 1));
          followed = true;
          break;
        }
        const cause = link.failure.cause;
        if (typeof cause === 'object' && cause !== null && 'code' in cause) {
          // Missing metadata cannot hide a symlink further down this path.
          if (cause.code === 'ENOENT') return resolved;
          if (cause.code === 'EINVAL') {
            nonLinks.add(component);
            continue;
          }
        }
        return yield* Effect.fail(new RepositoryPathUnavailable());
      }
      if (!followed) return resolved;
    }
    return yield* Effect.fail(new RepositoryPathUnavailable());
  });
  // Home itself can be an alias. Cover its physical protected folders too.
  const physicalHome = yield* safePath(home);
  roots.push(...protectedNames.map((name) => canonical(path.join(physicalHome, name))));
  return safePath;
});

// Identity is transport-independent and strips credentials. SSH and HTTPS
// remotes of the same repository combine across clones and worktrees.
export const canonicalRepository = (remote: string) => {
  const trimmed = remote.trim();
  const scp = /^(?:[^@/]+@)?([^/:]+):([^/].*)$/.exec(trimmed);
  let host = '';
  let repoPath = '';
  if (scp && !trimmed.includes('://')) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    try {
      const url = new URL(trimmed);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname;
      repoPath = url.pathname;
    } catch {
      return null;
    }
  }
  const normalized = repoPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !normalized) return null;
  return `${host.toLowerCase()}/${['github.com', 'gitlab.com', 'bitbucket.org'].includes(host.toLowerCase()) ? normalized.toLowerCase() : normalized}`;
};

const originRemote = (config: string) => {
  let origin = false;
  for (const line of config.split('\n')) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section) {
      origin = section[1] === 'origin';
      continue;
    }
    if (/^\s*\[/.test(line)) origin = false;
    if (origin) {
      const url = /^\s*url\s*=\s*(.*)$/.exec(line);
      if (url) return canonicalRepository(url[1]);
    }
  }
  return null;
};

const maximumMetadataBytes = 1_048_576n;
const readMetadata = Effect.fn('usage.readRepositoryMetadata')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.result(fs.stat(file));
  if (Result.isFailure(info) || info.success.type !== 'File' || info.success.size > maximumMetadataBytes) return null;
  const contents = yield* Effect.result(fs.readFileString(file));
  return Result.isSuccess(contents) && contents.success.length <= Number(maximumMetadataBytes)
    ? contents.success
    : null;
});

export const resolveRepository = Effect.fn('usage.resolveRepository')(
  function* (cwd: string, options: RepositoryOptions = {}) {
    if (!cwd || cwd === 'Unknown project') return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safePath = yield* makeRepositoryPathResolver(cwd, options);
    let directory = yield* safePath(cwd);
    for (let depth = 0; depth < 100; depth++) {
      const git = yield* safePath(path.join(directory, '.git'));
      const info = yield* Effect.result(fs.stat(git));
      if (Result.isSuccess(info)) {
        let gitDir = git;
        if (info.success.type !== 'Directory') {
          if (info.success.type !== 'File') return null;
          const pointer = yield* readMetadata(git);
          if (pointer === null) return null;
          const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1];
          if (!target) return null;
          gitDir = yield* safePath(path.resolve(directory, target.trim()));
        }
        // Linked worktrees share config in the common Git directory.
        const common = yield* readMetadata(yield* safePath(path.join(gitDir, 'commondir')));
        if (common !== null) gitDir = yield* safePath(path.resolve(gitDir, common.trim()));
        const config = yield* readMetadata(yield* safePath(path.join(gitDir, 'config')));
        const localIdentity = `local:${path.dirname(gitDir)}`;
        return config !== null ? (originRemote(config) ?? localIdentity) : localIdentity;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  },
  // Repository grouping is optional metadata. Cancellable filesystem reads
  // must not keep an otherwise complete token collection waiting indefinitely.
  (effect) =>
    effect.pipe(
      Effect.timeout('3 seconds'),
      Effect.catch(() => Effect.succeed(null)),
    ),
);

// Each collection keeps identities resolved within its optional metadata
// budget. A denied mount or authorization dialog must not delay every project.
export const makeRepositoryResolver = (options: RepositoryOptions = {}) => {
  let deadline: number | undefined;
  return Effect.fn('usage.resolveRepositoryWithinBudget')(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    deadline ??= now + 5_000;
    const remaining = deadline - now;
    if (remaining <= 0) return null;
    return yield* resolveRepository(cwd, options).pipe(
      Effect.timeout(remaining),
      Effect.catch(() => Effect.succeed(null)),
    );
  });
};
