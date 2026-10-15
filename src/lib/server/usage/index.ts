import { Effect, FileSystem, Path, Result, Stream } from 'effect';
import { CollectionError, type UsageEvent, type UsageResult } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { deduplicate, claudeParser, codexParser, museParser, piParser, type ParsedFile } from './parsers';
import {
  fileSignature,
  parsedCachePath,
  prepareParsedCache,
  pruneParsedCache,
  readParsedCache,
  writeParsedCache,
} from './cache';
import { estimateCost, resolveDisplayModel } from './pricing';
import { loadPricing } from './pricing-runtime';
import { makeRepositoryResolver } from './repository';
import { collectGrokFiles } from './grok';
import { readT3Metadata, t3MetadataKey } from './t3';
import { readUsageDirectory } from './files';
import { usageSourceRoots, type SourceRootOptions } from './source-roots';
import { rememberRepositoryDependencies } from './revision-dependencies';

export { buildDashboard, provider, validateTimezone } from './dashboard';
export { canonicalRepository, resolveRepository } from './repository';
export { tokenTotal } from './parsers';

export type CollectionOptions = SourceRootOptions & {
  deviceId?: string;
  pricingPolicy?: PricingPolicy;
  t3DataDirectory?: string;
  t3Url?: string;
  // Only background collection writes this optional metadata cache. Manual
  // checks omit it and remain entirely read-only.
  cacheDirectory?: string;
};
export const collectUsage = Effect.fn('usage.collect')(function* (options: CollectionOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pricingPolicy =
    options.pricingPolicy ??
    (yield* loadPricing().pipe(Effect.mapError((error) => new CollectionError({ message: error.message })))).policy;
  const { home, sources } = yield* usageSourceRoots(options);
  let incomplete = false;
  const markIncomplete = () => {
    incomplete = true;
  };
  const cacheDirectory =
    options.cacheDirectory && (yield* prepareParsedCache(options.cacheDirectory)) ? options.cacheDirectory : undefined;
  const warnings: string[] = [];
  const files: ParsedFile[] = [];
  const retainedCacheFiles = new Set<string>();
  for (const [sourceIndex, source] of sources.entries()) {
    if (source.harness === 'grok') continue;
    const realRoot = yield* Effect.result(fs.realPath(source.path));
    if (Result.isFailure(realRoot)) {
      if (realRoot.failure.reason._tag !== 'NotFound') {
        markIncomplete();
        source.status = 'error';
        source.error = 'Usage directory could not be read.';
        warnings.push(`${source.harness}: ${source.error}`);
      }
      continue;
    }
    const rootInfo = yield* Effect.result(fs.stat(realRoot.success));
    if (Result.isFailure(rootInfo) || rootInfo.success.type !== 'Directory') {
      if (Result.isFailure(rootInfo)) markIncomplete();
      source.status = 'error';
      source.error = 'Usage source is not a readable directory.';
      warnings.push(`${source.harness}: ${source.error}`);
      continue;
    }
    const paths: string[] = [];
    let unreadableDirectories = 0;
    const pending = [realRoot.success];
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) break;
      const listed = yield* Effect.result(readUsageDirectory(directory));
      if (Result.isFailure(listed)) {
        markIncomplete();
        unreadableDirectories++;
        continue;
      }
      for (const entry of listed.success) {
        const file = path.join(directory, entry.name);
        // Resolve the configured root, but skip arbitrary nested symlinks.
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile() && path.extname(file).toLowerCase() === '.jsonl') paths.push(file);
      }
    }
    paths.sort();
    source.files = paths.length;
    source.status = paths.length ? 'ready' : 'empty';
    let malformed = 0;
    let unreadable = 0;
    for (const file of paths) {
      const info = yield* Effect.result(fileSignature(file));
      if (Result.isFailure(info)) {
        markIncomplete();
        unreadable++;
        continue;
      }
      const cachePath = cacheDirectory ? parsedCachePath(cacheDirectory, source.harness, file) : undefined;
      if (cachePath) retainedCacheFiles.add(path.basename(cachePath));
      let parsed: ParsedFile | null = cachePath ? yield* readParsedCache(cachePath, info.success.signature) : null;
      if (!parsed) {
        const parser =
          source.harness === 'claude'
            ? claudeParser(file)
            : source.harness === 'codex'
              ? codexParser(file)
              : source.harness === 'muse'
                ? museParser(file)
                : piParser(file);
        const decoder = new TextDecoder();
        const contents = yield* Effect.result(
          fs
            .stream(file, { bytesToRead: info.success.size })
            .pipe(
              Stream.runForEach((chunk) => Effect.sync(() => parser.push(decoder.decode(chunk, { stream: true })))),
            ),
        );
        if (Result.isFailure(contents)) {
          markIncomplete();
          unreadable++;
          continue;
        }
        parser.push(decoder.decode());
        parsed = parser.finish();
        if (cachePath) {
          const afterRead = yield* Effect.result(fileSignature(file));
          if (Result.isSuccess(afterRead) && afterRead.success.signature === info.success.signature)
            yield* writeParsedCache(cachePath, info.success.signature, parsed);
        }
      }
      malformed += parsed.malformed;
      for (const entry of parsed.events) entry.source = sourceIndex;
      files.push(parsed);
    }
    if (malformed || unreadable || unreadableDirectories) {
      source.status = 'partial';
      source.error = `Skipped ${malformed} malformed records; ${unreadable} files and ${unreadableDirectories} directories could not be read.`;
      warnings.push(`${source.harness}: ${source.error}`);
    }
  }
  const grok = yield* collectGrokFiles(
    sources.flatMap((source, index) => (source.harness === 'grok' ? [{ source, index }] : [])),
    cacheDirectory,
    retainedCacheFiles,
  );
  files.push(...grok.files);
  warnings.push(...grok.warnings);
  if (grok.incomplete) markIncomplete();
  if (cacheDirectory) yield* pruneParsedCache(cacheDirectory, retainedCacheFiles);
  const candidateIds = new Set<string>();
  for (const file of files)
    for (const entry of file.events) {
      candidateIds.add(entry.event.id);
      // Retire old array-position advisor IDs only if no current call owns them.
      if (entry.legacyEventId) candidateIds.add(entry.legacyEventId);
    }
  const entries = deduplicate(files);
  const retainedIds = new Set(entries.map((entry) => entry.event.id));
  // Withdraw only identities proved to be replayed or replaced. Missing source
  // files remain uploaded history, including archived logs removed locally.
  const retractedIds = [...new Set([...candidateIds, ...files.flatMap((file) => file.retractedIds ?? [])])].filter(
    (id) => !retainedIds.has(id),
  );
  const repositories = new Map<string, string | null>();
  const repositoryDependencies = new Set<string>();
  const resolveRepository = makeRepositoryResolver({
    onDependency: (file) => repositoryDependencies.add(file),
    onFailure: markIncomplete,
  });
  for (const entry of entries) {
    if (!repositories.has(entry.event.project))
      repositories.set(entry.event.project, yield* resolveRepository(entry.event.project));
  }
  // T3 titles and thread bindings can change without touching usage logs. Read
  // them after the parser cache on every collection so warm syncs refresh them.
  const t3Metadata = yield* readT3Metadata({
    home,
    dataDirectory: options.t3DataDirectory,
    url: options.t3Url,
    onFailure: markIncomplete,
  });
  const sessionRepositories = new Map<string, string>();
  const attemptedSessionRepositories = new Set<string>();
  for (const entry of entries) {
    const key = t3MetadataKey(entry.event);
    const repository = repositories.get(entry.event.project);
    const metadata = t3Metadata.get(key);
    if (!metadata || attemptedSessionRepositories.has(key) || (repository && !repository.startsWith('local:')))
      continue;
    attemptedSessionRepositories.add(key);
    for (const cwd of metadata.repositoryPaths) {
      if (!repositories.has(cwd)) repositories.set(cwd, yield* resolveRepository(cwd));
      const attached = repositories.get(cwd);
      if (attached && !attached.startsWith('local:')) {
        sessionRepositories.set(key, attached);
        break;
      }
    }
  }
  const unknownModels = new Set<string>();
  const events: UsageEvent[] = entries
    .map((entry) => {
      const cost = estimateCost(entry.event, entry.cacheWrite1h, entry.tier, pricingPolicy);
      if (!cost.costKnown) unknownModels.add(entry.event.model);
      sources[entry.source].events++;
      const key = t3MetadataKey(entry.event);
      const metadata = t3Metadata.get(key);
      const repository = repositories.get(entry.event.project);
      return {
        ...entry.event,
        ...(metadata?.sessionTitle ? { sessionTitle: metadata.sessionTitle } : {}),
        ...(metadata?.projectName ? { projectName: metadata.projectName } : {}),
        ...(metadata?.t3ThreadId ? { t3ThreadId: metadata.t3ThreadId } : {}),
        ...(metadata?.t3ThreadUrl !== undefined ? { t3ThreadUrl: metadata.t3ThreadUrl } : {}),
        ...cost,
        rawModel: entry.event.model,
        model: resolveDisplayModel(entry.event.model, pricingPolicy),
        serviceTier: entry.tier,
        cacheWrite1hTokens: entry.cacheWrite1h,
        repository:
          repository && !repository.startsWith('local:')
            ? repository
            : (sessionRepositories.get(key) ?? repository ?? null),
        ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      };
    })
    .sort((left, right) =>
      left.timestamp < right.timestamp
        ? -1
        : left.timestamp > right.timestamp
          ? 1
          : left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0,
    );
  if (unknownModels.size)
    warnings.push(
      `No reliable API price for: ${[...unknownModels].sort().join(', ')}. These tokens are included, but their costs are unavailable.`,
    );
  const usage = {
    events,
    sources,
    warnings,
    pricingUpdatedAt: `${pricingPolicy.catalog.updatedAt} (${pricingPolicy.revision})`,
    ...(retractedIds.length ? { retractedIds } : {}),
  } satisfies UsageResult;
  rememberRepositoryDependencies(usage, repositoryDependencies, incomplete);
  return usage;
});
