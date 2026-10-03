import { Effect, FileSystem, Path, Result } from 'effect';

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

export const resolveRepository = Effect.fn('usage.resolveRepository')(function* (cwd: string) {
  if (!cwd || cwd === 'Unknown project') return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < 100; depth++) {
    const git = path.join(directory, '.git');
    const info = yield* Effect.result(fs.stat(git));
    if (Result.isSuccess(info)) {
      let gitDir = git;
      if (info.success.type !== 'Directory') {
        const pointer = yield* Effect.result(fs.readFileString(git));
        if (Result.isFailure(pointer)) return null;
        const target = /^gitdir:\s*(.+)$/m.exec(pointer.success)?.[1];
        if (!target) return null;
        gitDir = path.resolve(directory, target.trim());
      }
      // Linked worktrees share config in the common Git directory.
      const common = yield* Effect.result(fs.readFileString(path.join(gitDir, 'commondir')));
      if (Result.isSuccess(common)) gitDir = path.resolve(gitDir, common.success.trim());
      const config = yield* Effect.result(fs.readFileString(path.join(gitDir, 'config')));
      const localIdentity = `local:${path.dirname(gitDir)}`;
      return Result.isSuccess(config) ? (originRemote(config.success) ?? localIdentity) : localIdentity;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
});
