import { homedir } from 'node:os';
import { Effect, FileSystem, Path, Result, Stream } from 'effect';
import { CollectionError, type SourceStatus, type UsageEvent, type UsageResult } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { deduplicate, claudeParser, codexParser, piParser, type ParsedFile } from './parsers';
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

export { buildDashboard, provider, validateTimezone } from './dashboard';
export { canonicalRepository, resolveRepository } from './repository';
export { tokenTotal } from './parsers';

export type CollectionOptions = {
  home?: string;
  claudeDirs?: readonly string[];
  codexDirs?: readonly string[];
  piDirs?: readonly string[];
  grokDirs?: readonly string[];
  deviceId?: string;
  pricingPolicy?: PricingPolicy;
  // Only background collection writes this optional metadata cache. Manual
  // checks omit it and remain entirely read-only.
  cacheDirectory?: string;
};
type MutableSource = { -readonly [K in keyof SourceStatus]: SourceStatus[K] };

const environmentDirs = (name: string) => {
  const roots = process.env[name]
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return roots?.length ? roots : undefined;
};

export const collectUsage = Effect.fn('usage.collect')(function* (options: CollectionOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pricingPolicy =
    options.pricingPolicy ??
    (yield* loadPricing().pipe(Effect.mapError((error) => new CollectionError({ message: error.message })))).policy;
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
        source.status = 'error';
        source.error = 'Usage directory could not be read.';
        warnings.push(`${source.harness}: ${source.error}`);
      }
      continue;
    }
    const rootInfo = yield* Effect.result(fs.stat(realRoot.success));
    if (Result.isFailure(rootInfo) || rootInfo.success.type !== 'Directory') {
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
      const listed = yield* Effect.result(fs.readDirectory(directory));
      if (Result.isFailure(listed)) {
        unreadableDirectories++;
        continue;
      }
      for (const name of listed.success) {
        const file = path.join(directory, name);
        // Resolve the configured root, but skip arbitrary nested symlinks.
        const link = yield* Effect.result(fs.readLink(file));
        if (Result.isSuccess(link)) continue;
        const info = yield* Effect.result(fs.stat(file));
        if (Result.isFailure(info)) {
          unreadableDirectories++;
          continue;
        }
        if (info.success.type === 'Directory') pending.push(file);
        else if (info.success.type === 'File' && path.extname(file).toLowerCase() === '.jsonl') paths.push(file);
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
  if (cacheDirectory) yield* pruneParsedCache(cacheDirectory, retainedCacheFiles);
  const candidateIds = new Set(files.flatMap((file) => file.events.map((entry) => entry.event.id)));
  const entries = deduplicate(files);
  const retainedIds = new Set(entries.map((entry) => entry.event.id));
  // Withdraw only identities proved to be replayed or replaced. Missing source
  // files remain uploaded history, including archived logs removed locally.
  const retractedIds = [...new Set([...candidateIds, ...files.flatMap((file) => file.retractedIds ?? [])])].filter(
    (id) => !retainedIds.has(id),
  );
  const repositories = new Map<string, string | null>();
  const resolveRepository = makeRepositoryResolver();
  for (const entry of entries) {
    if (!repositories.has(entry.event.project))
      repositories.set(entry.event.project, yield* resolveRepository(entry.event.project));
  }
  const unknownModels = new Set<string>();
  const events: UsageEvent[] = entries
    .map((entry) => {
      const cost = estimateCost(entry.event, entry.cacheWrite1h, entry.tier, pricingPolicy);
      if (!cost.costKnown) unknownModels.add(entry.event.model);
      sources[entry.source].events++;
      return {
        ...entry.event,
        ...cost,
        rawModel: entry.event.model,
        model: resolveDisplayModel(entry.event.model, pricingPolicy),
        serviceTier: entry.tier,
        cacheWrite1hTokens: entry.cacheWrite1h,
        repository: repositories.get(entry.event.project) ?? null,
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
  return {
    events,
    sources,
    warnings,
    pricingUpdatedAt: `${pricingPolicy.catalog.updatedAt} (${pricingPolicy.revision})`,
    ...(retractedIds.length ? { retractedIds } : {}),
  } satisfies UsageResult;
});
