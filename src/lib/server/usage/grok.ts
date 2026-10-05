import type { UsageEvent, SourceStatus } from '../../shared/domain';
import { CollectionError } from '../../shared/domain';
import { Effect, FileSystem, Path, Result, Stream } from 'effect';
import { fileSignature, parsedCachePath, prepareParsedCache, readParsedCache, writeParsedCache } from './cache';
import type { ParsedFile } from './parsers';

type MutableSource = { -readonly [K in keyof SourceStatus]: SourceStatus[K] };
type Metadata = Record<string, unknown>;
type Session = {
  directory: string;
  source: MutableSource;
  index: number;
  sessionId: string;
  project: string;
  model: string;
  parentId: string;
  forkedAt: string;
  kind: string;
  signature: string;
  ledger: string | null;
  updates: string | null;
  parsed: ParsedFile | null;
};
const isObject = (value: unknown): value is Metadata =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const object = (value: unknown) => (isObject(value) ? value : {});
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown) => (tokenCount(value) ? value : 0);
const timestamp = (value: unknown) => {
  const millis =
    typeof value === 'number'
      ? value > 1e11
        ? value
        : value * 1000
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : '';
};
// Neither counters nor file paths form the identity: corrections, copied logs,
// and the transition from the legacy stream to a compact ledger are upserts.
const turnId = (session: string, turn: number, model: string) =>
  `grok:turn:${encodeURIComponent(session)}:${turn}:${encodeURIComponent(model)}`;
const turnNumber = (event: UsageEvent) => Number(event.id.split(':')[3]);
const subagentKind = (session: Session) => session.kind.startsWith('subagent');
const incompleteFlag = (usage: Metadata, key: string) => usage[key] !== undefined && usage[key] !== false;
const incompleteCost = (usage: Metadata) =>
  ['costIsPartial', 'usageIsIncomplete'].some((key) => incompleteFlag(usage, key));
const emptyParsed = (sessionId: string): ParsedFile => ({
  events: [],
  malformed: 0,
  sessionId,
  parentId: '',
  forkedAt: '',
});

const appendUsage = (
  parsed: ParsedFile,
  usage: Metadata,
  session: Session,
  turn: number,
  stamp: string,
  fallbackModel: string,
) => {
  const modelUsage = object(usage.modelUsage);
  const perModel = Object.keys(modelUsage).length > 0;
  const rows = perModel
    ? Object.entries(modelUsage).map(([model, row]) => [model, object(row)] as const)
    : [[text(usage.primaryModelId) || fallbackModel || 'unknown', usage] as const];
  for (const [model, row] of rows) {
    if (!tokenCount(row.inputTokens) || !tokenCount(row.outputTokens)) {
      parsed.malformed++;
      continue;
    }
    if (
      ['cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'modelCalls'].some(
        (key) => row[key] !== undefined && !tokenCount(row[key]),
      )
    ) {
      parsed.malformed++;
      continue;
    }
    const input = row.inputTokens;
    const output = row.outputTokens;
    const cacheRead = Math.min(input, count(row.cachedReadTokens));
    const cacheWrite = Math.min(input - cacheRead, count(row.cacheCreationTokens));
    if (!input && !output) continue;
    // Grok includes cache reads/writes in input, and reasoning in output.
    // A positive, complete native cost avoids applying per-request context
    // thresholds to a row that can aggregate hundreds of model calls.
    const cost =
      !incompleteCost(row) &&
      !incompleteFlag(usage, 'usageIsIncomplete') &&
      tokenCount(row.costUsdTicks) &&
      row.costUsdTicks > 0
        ? row.costUsdTicks / 1e10
        : undefined;
    const event = {
      id: turnId(session.sessionId, turn, model || 'unknown'),
      timestamp: stamp,
      harness: 'grok',
      sessionId: session.sessionId,
      model: model || 'unknown',
      project: session.project,
      repository: null,
      inputTokens: input - cacheRead - cacheWrite,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: Math.min(output, count(row.reasoningTokens)),
      costUsd: cost ?? 0,
      costKnown: cost !== undefined,
      ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
      ...(tokenCount(row.modelCalls) ? { requests: row.modelCalls } : {}),
    } satisfies UsageEvent;
    parsed.events.push({ event, source: session.index, sidechain: false, cacheWrite1h: 0, tier: '' });
  }
};

const parseLedger = (value: unknown, session: Session) => {
  const ledger = object(value);
  const parsed = emptyParsed(session.sessionId);
  if (!Array.isArray(ledger.turns) || (text(ledger.sessionId) && text(ledger.sessionId) !== session.sessionId)) {
    parsed.malformed++;
    return parsed;
  }
  for (const value of ledger.turns) {
    const row = object(value);
    const turn = count(row.turnNumber);
    const stamp = timestamp(row.endedAt);
    if (!turn || !stamp) {
      parsed.malformed++;
      continue;
    }
    appendUsage(parsed, row, session, turn, stamp, session.model);
  }
  return parsed;
};

const updateParser = (session: Session) => {
  const parsed = emptyParsed(session.sessionId);
  const maximumLength = 32 * 1024 * 1024;
  let fragments: string[] = [];
  let length = 0;
  let turn = 0;
  let model = session.model;
  const completed = new Map<string, number>();
  const flush = (complete: boolean) => {
    if (length > maximumLength) parsed.malformed++;
    else {
      const line = fragments.length === 1 ? fragments[0] : fragments.join('');
      if (line.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          if (complete) parsed.malformed++;
          fragments = [];
          length = 0;
          return;
        }
        const record = object(value);
        const params = object(record.params);
        const update = object(params.update);
        model = text(object(update._meta).modelId) || model;
        if (update.sessionUpdate === 'turn_completed') {
          // usage.numTurns counts inference loops, and T3 can reuse prompt_id
          // in the same session. The user-turn ordinal matches usage.json.
          const nativeId = text(object(params._meta).eventId);
          const existingTurn = nativeId ? completed.get(nativeId) : undefined;
          const ordinal = existingTurn ?? ++turn;
          if (nativeId) completed.set(nativeId, ordinal);
          if (update.usage !== undefined) {
            const stamp = timestamp(object(params._meta).agentTimestampMs) || timestamp(record.timestamp);
            if (!stamp) parsed.malformed++;
            else {
              const replacement = emptyParsed(session.sessionId);
              appendUsage(replacement, object(update.usage), session, ordinal, stamp, model);
              parsed.malformed += replacement.malformed;
              if (existingTurn === undefined || !replacement.malformed) {
                if (existingTurn !== undefined)
                  parsed.events = parsed.events.filter((entry) => turnNumber(entry.event) !== ordinal);
                parsed.events.push(...replacement.events);
              }
            }
          } else if (existingTurn !== undefined) parsed.malformed++;
        }
      }
    }
    fragments = [];
    length = 0;
  };
  return {
    push(chunk: string) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf('\n', offset);
        const fragment = chunk.slice(offset, end === -1 ? undefined : end);
        length += fragment.length;
        if (length <= maximumLength) fragments.push(fragment);
        else fragments = [];
        if (end === -1) break;
        flush(true);
        offset = end + 1;
      }
    },
    finish() {
      if (length) flush(false);
      return parsed;
    },
  };
};

export const collectGrokFiles = Effect.fn('usage.collectGrokFiles')(function* (
  sources: readonly { source: MutableSource; index: number }[],
  cacheDirectory?: string,
  retainedCacheFiles?: Set<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = cacheDirectory && (yield* prepareParsedCache(cacheDirectory)) ? cacheDirectory : undefined;
  const warnings: string[] = [];
  const sessions: Session[] = [];
  const parents = new Map<string, string>();
  const problems = new Map<
    MutableSource,
    { malformed: number; unreadable: number; directories: number; orphans: number }
  >();
  const readBounded = Effect.fn('usage.grok.readBounded')(function* (file: string, maximumBytes: number) {
    const info = yield* fileSignature(file);
    if (info.size > BigInt(maximumBytes))
      return yield* Effect.fail(new CollectionError({ message: 'Grok metadata exceeds the supported size.' }));
    const decoder = new TextDecoder();
    const fragments: string[] = [];
    yield* fs
      .stream(file, { bytesToRead: info.size })
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => fragments.push(decoder.decode(chunk, { stream: true })))));
    fragments.push(decoder.decode());
    return { contents: fragments.join(''), signature: info.signature };
  });
  const readJson = Effect.fn('usage.grok.readJson')(function* (file: string, maximumBytes: number) {
    const read = yield* readBounded(file, maximumBytes);
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(read.contents),
      catch: () => new CollectionError({ message: 'Grok metadata is invalid.' }),
    });
    return { value, signature: read.signature };
  });
  const regularFile = Effect.fn('usage.grok.regularFile')(function* (file: string) {
    if (Result.isSuccess(yield* Effect.result(fs.readLink(file)))) return false;
    const info = yield* Effect.result(fs.stat(file));
    return Result.isSuccess(info) && info.success.type === 'File';
  });
  const directories = Effect.fn('usage.grok.directories')(function* (
    directory: string,
    problem: { directories: number },
  ) {
    const listed = yield* Effect.result(fs.readDirectory(directory));
    if (Result.isFailure(listed)) {
      problem.directories++;
      return [];
    }
    const results: string[] = [];
    for (const name of listed.success) {
      const child = path.join(directory, name);
      if (Result.isSuccess(yield* Effect.result(fs.readLink(child)))) continue;
      const info = yield* Effect.result(fs.stat(child));
      if (Result.isFailure(info)) problem.directories++;
      else if (info.success.type === 'Directory') results.push(child);
    }
    return results.sort();
  });

  for (const { source, index } of sources) {
    source.files = 0;
    delete source.error;
    source.status = 'missing';
    const problem = { malformed: 0, unreadable: 0, directories: 0, orphans: 0 };
    problems.set(source, problem);
    const root = yield* Effect.result(fs.realPath(source.path));
    if (Result.isFailure(root)) {
      if (root.failure.reason._tag !== 'NotFound') {
        source.status = 'error';
        source.error = 'Grok usage directory could not be read.';
        warnings.push(`grok: ${source.error}`);
      }
      continue;
    }
    const info = yield* Effect.result(fs.stat(root.success));
    if (Result.isFailure(info) || info.success.type !== 'Directory') {
      source.status = 'error';
      source.error = 'Grok usage source is not a readable directory.';
      warnings.push(`grok: ${source.error}`);
      continue;
    }
    source.status = 'empty';
    for (const group of yield* directories(root.success, problem)) {
      let groupProject = '';
      let groupSignature = '';
      try {
        const decoded = decodeURIComponent(path.basename(group));
        if (path.isAbsolute(decoded)) groupProject = decoded;
      } catch {
        // Long or unusual directory names use the optional .cwd metadata.
      }
      if (!groupProject && (yield* regularFile(path.join(group, '.cwd')))) {
        const cwd = yield* Effect.result(readBounded(path.join(group, '.cwd'), 16 * 1024));
        if (Result.isSuccess(cwd)) {
          groupProject = cwd.success.contents.trim();
          groupSignature = cwd.success.signature;
        } else problem.unreadable++;
      }
      for (const directory of yield* directories(group, problem)) {
        let summary: Metadata = {};
        let summarySignature = 'missing';
        const summaryPath = path.join(directory, 'summary.json');
        if (yield* regularFile(summaryPath)) {
          const read = yield* Effect.result(readJson(summaryPath, 1024 * 1024));
          if (Result.isSuccess(read)) {
            summary = object(read.success.value);
            summarySignature = read.success.signature;
          } else problem.malformed++;
        }
        const session: Session = {
          directory,
          source,
          index,
          sessionId: text(object(summary.info).id) || path.basename(directory),
          project: text(object(summary.info).cwd) || groupProject || 'Unknown project',
          model: text(summary.current_model_id),
          parentId: text(summary.parent_session_id),
          forkedAt: timestamp(summary.forked_at) || timestamp(summary.created_at),
          kind: text(summary.session_kind),
          signature: `${summarySignature}:${groupSignature}`,
          ledger: (yield* regularFile(path.join(directory, 'usage.json'))) ? path.join(directory, 'usage.json') : null,
          updates: (yield* regularFile(path.join(directory, 'updates.jsonl')))
            ? path.join(directory, 'updates.jsonl')
            : null,
          parsed: null,
        };
        sessions.push(session);
        const subagents = path.join(directory, 'subagents');
        const subagentInfo = yield* Effect.result(fs.stat(subagents));
        if (Result.isSuccess(subagentInfo) && subagentInfo.success.type === 'Directory') {
          if (Result.isSuccess(yield* Effect.result(fs.readLink(subagents)))) continue;
          for (const child of yield* directories(subagents, problem)) {
            const file = path.join(child, 'meta.json');
            if (!(yield* regularFile(file))) continue;
            const meta = yield* Effect.result(readJson(file, 1024 * 1024));
            if (Result.isFailure(meta)) {
              problem.malformed++;
              continue;
            }
            // meta.json also contains the child's prompt. Retain only billed
            // ownership IDs, never prompt/description/tool content.
            const row = object(meta.success.value);
            const childId = text(row.child_session_id);
            const parentId = text(row.parent_session_id) || session.sessionId;
            if (childId && childId !== parentId) parents.set(childId, parentId);
          }
        }
      }
    }
  }

  for (const session of sessions) {
    if (!session.ledger && !session.updates) continue;
    session.source.files++;
    const problem = problems.get(session.source)!;
    // Native parent turn totals already fold child accounting. An orphan must
    // not be uploaded standalone and later double-counted when its parent
    // arrives: device sync does not remove previously uploaded source rows.
    if (subagentKind(session) || parents.has(session.sessionId)) continue;
    let ledgerMalformed = 0;
    let parsedLedger = false;
    const parseFile = Effect.fn('usage.grok.parseFile')(function* (file: string, ledger: boolean) {
      const info = yield* fileSignature(file);
      const signature = `grok-v1:${info.signature}:${session.signature}`;
      const destination = cache ? parsedCachePath(cache, 'grok', file) : undefined;
      if (destination) retainedCacheFiles?.add(path.basename(destination));
      const cached = destination ? yield* readParsedCache(destination, signature) : null;
      if (cached) return cached;
      let parsed: ParsedFile;
      if (ledger) {
        const read = yield* readJson(file, 64 * 1024 * 1024);
        parsed = parseLedger(read.value, session);
      } else {
        const parser = updateParser(session);
        const decoder = new TextDecoder();
        yield* fs
          .stream(file, { bytesToRead: info.size })
          .pipe(Stream.runForEach((chunk) => Effect.sync(() => parser.push(decoder.decode(chunk, { stream: true })))));
        parser.push(decoder.decode());
        parsed = parser.finish();
      }
      if (destination) {
        const after = yield* Effect.result(fileSignature(file));
        if (Result.isSuccess(after) && after.success.signature === info.signature)
          yield* writeParsedCache(destination, signature, parsed);
      }
      return parsed;
    });
    if (session.ledger) {
      const read = yield* Effect.result(parseFile(session.ledger, true));
      if (Result.isSuccess(read)) {
        session.parsed = read.success;
        parsedLedger = true;
        ledgerMalformed = read.success.malformed;
      } else ledgerMalformed = 1;
    }
    if ((!session.parsed || ledgerMalformed) && session.updates) {
      const read = yield* Effect.result(parseFile(session.updates, false));
      if (Result.isSuccess(read)) {
        session.parsed = read.success;
        parsedLedger = false;
      } else problem.unreadable++;
    }
    problem.malformed += (parsedLedger ? 0 : ledgerMalformed) + (session.parsed?.malformed ?? 0);
    if (!session.parsed && !ledgerMalformed) problem.unreadable++;
    for (const entry of session.parsed?.events ?? []) entry.source = session.index;
  }

  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  // Cache the native turn/timestamp lookup once. Scanning every parent row for
  // every inherited child row makes large fork collections quadratic, even
  // when all accounting files are already cached.
  const nativeTurns = new Map<string, Map<string, Set<number>>>();
  for (const session of sessions) {
    const turns = nativeTurns.get(session.sessionId) ?? new Map<string, Set<number>>();
    for (const { event } of session.parsed?.events ?? []) {
      const key = `${turnNumber(event)}:${event.model}`;
      const stamps = turns.get(key) ?? new Set<number>();
      stamps.add(Date.parse(event.timestamp));
      turns.set(key, stamps);
    }
    nativeTurns.set(session.sessionId, turns);
  }
  for (const session of sessions) {
    if (!subagentKind(session) && !parents.has(session.sessionId)) continue;
    let parentId = parents.get(session.sessionId) || session.parentId;
    let parent = parentId ? byId.get(parentId) : undefined;
    const visited = new Set<string>([session.sessionId]);
    while (parent && (subagentKind(parent) || parents.has(parent.sessionId)) && !visited.has(parent.sessionId)) {
      visited.add(parent.sessionId);
      parentId = parents.get(parent.sessionId) || parent.parentId;
      parent = parentId ? byId.get(parentId) : undefined;
    }
    if (!parent || (!parent.ledger && !parent.updates) || !parent.parsed) problems.get(session.source)!.orphans++;
  }
  // A native fork preserves inherited turn numbers/timestamps and starts new
  // turns after its creation timestamp. Canonicalize inherited IDs even when
  // only the copy is available; no token-content fingerprints are necessary.
  for (const session of sessions) {
    if (!session.parsed || !session.parentId) continue;
    for (const entry of session.parsed.events) {
      const { event } = entry;
      let owner = session;
      const visited = new Set<string>();
      while (owner.parentId && !visited.has(owner.sessionId)) {
        const parent = byId.get(owner.parentId);
        const stamps = nativeTurns.get(owner.parentId)?.get(`${turnNumber(event)}:${event.model}`);
        const millis = Date.parse(event.timestamp);
        const inherited = stamps && [-2, -1, 0, 1, 2].some((offset) => stamps.has(millis + offset));
        const beforeCopy = owner.forkedAt && event.timestamp < owner.forkedAt;
        const absentParentTie = !parent && owner.forkedAt && event.timestamp === owner.forkedAt;
        if (!inherited && !beforeCopy && !absentParentTie) break;
        visited.add(owner.sessionId);
        event.sessionId = owner.parentId;
        if (!parent) break;
        owner = parent;
      }
      event.id = turnId(event.sessionId, turnNumber(event), event.model);
      // An inherited snapshot can be stale. The original owner must win even
      // when its corrected counters or cost are lower than a copied version.
      entry.sidechain = event.sessionId !== session.sessionId;
    }
  }
  for (const { source } of sources) {
    if (source.status === 'error' || source.status === 'missing') continue;
    const problem = problems.get(source)!;
    source.status = source.files ? 'ready' : 'empty';
    if (problem.malformed || problem.unreadable || problem.directories || problem.orphans) {
      source.status = 'partial';
      source.error = `Skipped ${problem.malformed} malformed records; ${problem.unreadable} files and ${problem.directories} directories could not be read.${problem.orphans ? ` ${problem.orphans} subagent sessions have no readable parent accounting.` : ''}`;
      warnings.push(`grok: ${source.error}`);
    }
  }
  return { files: sessions.flatMap((session) => (session.parsed ? [session.parsed] : [])), warnings };
});
