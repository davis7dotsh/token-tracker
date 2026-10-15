import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Path, Result } from 'effect';
import { CollectionError, type UsageResult } from '../../shared/domain';
import type { CollectionOptions } from './index';
import { makeRepositoryPathResolver, skippedRepositoryPath, type RepositoryOptions } from './repository';
import { usageRepositoryDependencies, usageSnapshotIncomplete } from './revision-dependencies';
import { usageSourceRoots } from './source-roots';

const missing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
const fingerprint = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
let retryRevision = 0;
const grokMetadata = new Set(['.cwd', 'summary.json', 'usage.json', 'meta.json']);
const fileInfo = async (file: string, follow = false) => {
  try {
    return await (follow ? stat(file, { bigint: true }) : lstat(file, { bigint: true }));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};
const inventory = async (root: string, grok: boolean) => {
  const records: string[] = [];
  let physical: string;
  try {
    // Configured roots may be aliases. Nested symlinks are excluded just as
    // they are in collection; arbitrary links never expand the inventory.
    physical = await realpath(root);
  } catch (error) {
    if (missing(error)) return [`missing:${root}`];
    throw error;
  }
  records.push(`root:${root}:${physical}`);
  const pending = [physical];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) break;
    const info = await fileInfo(directory);
    records.push(`directory:${directory}:${info ? fingerprint(info) : 'missing'}`);
    if (!info?.isDirectory()) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (
        entry.isFile() &&
        (entry.name.toLowerCase().endsWith('.jsonl') || (grok && grokMetadata.has(entry.name)))
      ) {
        const info = await fileInfo(file);
        records.push(`file:${file}:${info ? fingerprint(info) : 'missing'}`);
      }
    }
  }
  return records;
};

// Only directory entries and stat metadata are read. In particular this does
// not parse logs, touch the parser cache, query SQLite, or serialize events.
// Snapshot reuse is checked against these input revisions, rather than time.
export const usageRevision = (options: CollectionOptions = {}, repositoryOptions: RepositoryOptions = {}) =>
  Effect.fn('usage.revision')(function* (previous?: UsageResult) {
    const path = yield* Path.Path;
    const { home, sources } = yield* usageSourceRoots(options);
    let optionalUnavailable = false;
    const records = yield* Effect.tryPromise({
      try: async () => {
        const inventoryRecords: string[] = [];
        for (const source of sources) {
          inventoryRecords.push(`source:${source.harness}:${source.path}`);
          inventoryRecords.push(...(await inventory(source.path, source.harness === 'grok')));
        }
        const configured = options.t3DataDirectory ?? process.env.TOKEN_TRACKER_T3_DATA_DIR;
        const root = configured?.trim() || path.join(home, '.t3', 'userdata');
        const t3Directory = path.resolve(
          root === '~' ? home : root.startsWith('~/') ? path.join(home, root.slice(2)) : root,
        );
        inventoryRecords.push(
          `t3:${t3Directory}:${options.t3Url ?? process.env.TOKEN_TRACKER_T3_URL ?? 'https://app.t3.codes'}`,
        );
        for (const name of [
          'environment-id',
          'statev2.sqlite',
          'statev2.sqlite-wal',
          'statev2.sqlite-journal',
          'state.sqlite',
          'state.sqlite-wal',
          'state.sqlite-journal',
        ]) {
          const file = path.join(t3Directory, name);
          try {
            const info = await fileInfo(file, true);
            inventoryRecords.push(`t3-file:${file}:${info ? fingerprint(info) : 'missing'}`);
          } catch {
            // T3 labels are optional. Failed observation must retry without
            // preventing otherwise healthy token accounting from loading.
            optionalUnavailable = true;
            inventoryRecords.push(`t3-file:${file}:unavailable`);
          }
        }
        return inventoryRecords;
      },
      catch: () => new CollectionError({ message: 'Could not check local usage files for changes. Try again.' }),
    });
    const dependencies = [...usageRepositoryDependencies(previous)].sort();
    if (dependencies.length) {
      // Reuse the collector's component-by-component macOS privacy guard.
      // A link retargeted into a protected folder must never be stat'ed.
      const resolver = yield* Effect.result(
        makeRepositoryPathResolver(dependencies[0], { ...repositoryOptions, home: repositoryOptions.home ?? home }),
      );
      if (Result.isFailure(resolver)) {
        if (skippedRepositoryPath(resolver.failure)) records.push('repository:skipped');
        else {
          optionalUnavailable = true;
          records.push('repository:unavailable');
        }
      }
      for (const dependency of Result.isSuccess(resolver) ? dependencies : []) {
        if (Result.isFailure(resolver)) break;
        // Resolve ancestors before lstat'ing the final component. Inspecting a
        // symlink itself is safe even when its target is intentionally private.
        const parent = yield* Effect.result(resolver.success(path.dirname(dependency)));
        if (Result.isFailure(parent)) {
          if (skippedRepositoryPath(parent.failure)) records.push(`repository:skipped:${dependency}`);
          else {
            optionalUnavailable = true;
            records.push(`repository:unavailable:${dependency}`);
          }
          continue;
        }
        const safe = path.join(parent.success, path.basename(dependency));
        const observed = yield* Effect.result(
          Effect.tryPromise({
            try: () => fileInfo(safe),
            catch: () => new CollectionError({ message: 'Could not check repository metadata for changes.' }),
          }),
        );
        if (Result.isFailure(observed)) {
          optionalUnavailable = true;
          records.push(`repository:unavailable:${dependency}`);
          continue;
        }
        const info = observed.success;
        // Directory identity matters for replaced roots and links; unrelated
        // working-tree writes do not change repository grouping metadata.
        const signature = info?.isDirectory() ? `${info.dev}:${info.ino}` : info ? fingerprint(info) : 'missing';
        records.push(`repository:${dependency}:${safe}:${signature}`);
      }
    }
    records.sort();
    const hash = createHash('sha256');
    for (const record of records) hash.update(`${record.length}:${record}`);
    const signature = hash.digest('hex');
    // A transient optional metadata/file read can fail without a stat change.
    // Such partial collections must retry rather than become timeless truth.
    return optionalUnavailable || usageSnapshotIncomplete(previous)
      ? `${signature}:retry:${++retryRevision}`
      : signature;
  });
