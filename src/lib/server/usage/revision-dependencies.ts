import type { UsageResult } from '../../shared/domain';

// Internal dependency paths never enter RPC/upload payloads. Keep the paths
// discovered by the collector's guarded repository reads with that snapshot.
const incompleteSnapshots = new WeakSet<UsageResult>();
const repositoryDependencies = new WeakMap<UsageResult, ReadonlySet<string>>();
export const rememberRepositoryDependencies = (usage: UsageResult, paths: ReadonlySet<string>, incomplete = false) => {
  repositoryDependencies.set(usage, paths);
  if (incomplete) incompleteSnapshots.add(usage);
};
export const usageRepositoryDependencies = (usage?: UsageResult) =>
  usage ? (repositoryDependencies.get(usage) ?? new Set<string>()) : new Set<string>();

export const usageSnapshotIncomplete = (usage?: UsageResult) => usage !== undefined && incompleteSnapshots.has(usage);
