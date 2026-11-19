import { canonicalRepository } from '../usage/repository';

// A folder and the repository a collector resolved for it with Git on that
// machine. The hub already stores these pairs; traces only know the folder.
export type ProjectPath = { readonly machine: string; readonly path: string; readonly repository: string | null };

const separators = /[\\/]+/g;
const normalize = (path: string) => path.trim().replace(separators, '/').replace(/\/$/, '');
// T3 Code keeps worktrees at ~/.t3/worktrees/<project>/<id> and checkouts at
// ~/.t3/projects/<project>, on every platform; both name the same project.
const t3Project = (path: string) => /\/\.t3\/(?:worktrees|projects)\/([^/]+)(?:\/|$)/.exec(path)?.[1];
// Scratch folders are not repositories; collectors group them by folder.
const isScratch = (path: string) => /\/\.t3\/scratch(?:\/|$)/.test(path);

const mostCommon = (counts: Map<string, Map<string, number>>) =>
  new Map(
    [...counts].map(([key, values]) => [
      key,
      [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    ]),
  );
const count = (counts: Map<string, Map<string, number>>, key: string, repository: string) => {
  let values = counts.get(key);
  if (!values) counts.set(key, (values = new Map()));
  values.set(repository, (values.get(repository) ?? 0) + 1);
};

// Resolve a trace session's repository the way its collector would have:
// the client's reported remote (Codex), else what Git said for this folder on
// this machine, any machine, the same T3 project, or an enclosing folder.
// Folders with no known repository stay ungrouped (null), like collectors.
export const makeProjectResolver = (pairs: readonly ProjectPath[]) => {
  const byMachine = new Map<string, Map<string, number>>();
  const byPath = new Map<string, Map<string, number>>();
  const byT3 = new Map<string, Map<string, number>>();
  for (const pair of pairs) {
    if (!pair.repository) continue;
    const path = normalize(pair.path);
    count(byMachine, `${pair.machine}\0${path}`, pair.repository);
    count(byPath, path, pair.repository);
    const project = t3Project(path);
    // A T3 project's local identity names one folder; only remotes generalize.
    if (project && !pair.repository.startsWith('local:')) count(byT3, project, pair.repository);
  }
  const machinePaths = mostCommon(byMachine);
  const paths = mostCommon(byPath);
  const t3 = mostCommon(byT3);
  const roots = [...paths.keys()].sort((a, b) => b.length - a.length);
  const memo = new Map<string, string | null>();
  return (machine: string, cwd: string, reported: string) => {
    const remote = reported.trim() ? canonicalRepository(reported) : null;
    if (remote) return remote;
    const path = normalize(cwd);
    if (!path) return null;
    const key = `${machine}\0${path}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const project = t3Project(path);
    const enclosing = () => {
      if (isScratch(path)) return undefined;
      const root = roots.find((candidate) => path.startsWith(`${candidate}/`));
      return root === undefined ? undefined : paths.get(root);
    };
    const repository =
      machinePaths.get(key) ?? paths.get(path) ?? (project ? t3.get(project) : undefined) ?? enclosing() ?? null;
    memo.set(key, repository);
    return repository;
  };
};
