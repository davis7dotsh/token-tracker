import { homedir } from 'node:os';
import { Effect, FileSystem, Path, Result } from 'effect';
import { CollectionError, type SourceStatus } from '../../shared/domain';

export type SourceRootOptions = {
  home?: string;
  claudeDirs?: readonly string[];
  codexDirs?: readonly string[];
  piDirs?: readonly string[];
  grokDirs?: readonly string[];
  museDirs?: readonly string[];
};
type MutableSource = { -readonly [K in keyof SourceStatus]: SourceStatus[K] };

const environmentDirs = (name: string) => {
  const roots = process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return roots?.length ? roots : undefined;
};

export const usageSourceRoots = Effect.fn('usage.sourceRoots')(function* (options: SourceRootOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Effect.try({
    try: () => path.resolve(options.home || homedir()),
    catch: () => new CollectionError({ message: 'Could not locate the home directory.' }),
  });
  const expandPath = (root: string) =>
    path.resolve(root === '~' ? home : root.startsWith('~/') ? path.join(home, root.slice(2)) : root);
  let claudeDirs = options.claudeDirs ?? environmentDirs('CLAUDE_CONFIG_DIR');
  if (!claudeDirs?.length && options.claudeDirs === undefined && !process.env.CLAUDE_CONFIG_DIR?.trim()) {
    claudeDirs = [path.join(home, '.claude')];
    const xdgRoot = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude');
    const xdg = yield* Effect.result(fs.stat(path.join(xdgRoot, 'projects')));
    if (Result.isSuccess(xdg) && xdg.success.type === 'Directory') claudeDirs = [...claudeDirs, xdgRoot];
  }
  const codexDirs = options.codexDirs ?? environmentDirs('CODEX_HOME') ?? [path.join(home, '.codex')];
  const piDirs = options.piDirs ?? environmentDirs('PI_CODING_AGENT_DIR') ?? [path.join(home, '.pi', 'agent')];
  const grokDirs = options.grokDirs ?? environmentDirs('GROK_HOME') ?? [path.join(home, '.grok')];
  // Muse keeps session logs under the XDG data directory on every platform.
  const museDirs = options.museDirs ??
    environmentDirs('MUSE_HOME') ?? [
      path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'muse'),
    ];
  const sources: MutableSource[] = [];
  const seen = new Set<string>();
  const addSource = (harness: SourceStatus['harness'], root: string) => {
    const expanded = expandPath(root);
    const key = `${harness}:${expanded}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ harness, path: expanded, files: 0, events: 0, status: 'missing' });
  };
  for (const root of claudeDirs ?? [])
    addSource('claude', path.basename(root.replace(/\/$/, '')) === 'projects' ? root : path.join(root, 'projects'));
  for (const root of codexDirs) {
    if (['sessions', 'archived_sessions'].includes(path.basename(root.replace(/\/$/, '')))) addSource('codex', root);
    else {
      addSource('codex', path.join(root, 'sessions'));
      addSource('codex', path.join(root, 'archived_sessions'));
    }
  }
  for (const root of piDirs)
    addSource('pi', path.basename(root.replace(/\/$/, '')) === 'sessions' ? root : path.join(root, 'sessions'));
  for (const root of grokDirs)
    addSource('grok', path.basename(root.replace(/\/$/, '')) === 'sessions' ? root : path.join(root, 'sessions'));
  for (const root of museDirs)
    addSource('muse', path.basename(root.replace(/\/$/, '')) === 'sessions' ? root : path.join(root, 'sessions'));
  return { home, sources };
});
