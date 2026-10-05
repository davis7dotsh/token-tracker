import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, FileSystem, Result, Schema } from 'effect';
import { CollectionError, UsageEvent } from '../../shared/domain';
import type { ParsedFile } from './parsers';

// This cache contains only the same accounting/session metadata as an upload.
// Its format is separate from pricing: every collection reapplies current rates
// and aliases, even when the source file itself has not changed.
const CachedFile = Schema.Struct({
  version: Schema.Literal(1),
  signature: Schema.String,
  file: Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        event: UsageEvent,
        source: Schema.Number,
        sidechain: Schema.Boolean,
        cacheWrite1h: Schema.Number,
        tier: Schema.String,
      }),
    ),
    malformed: Schema.Number,
    sessionId: Schema.String,
    parentId: Schema.String,
    forkedAt: Schema.String,
    compactionIds: Schema.Array(Schema.String),
  }),
});
const decodeCache = Schema.decodeUnknownSync(CachedFile);

// Nanosecond change times detect same-size corrections and file replacement,
// including rewrites that restore the original modification time.
export const fileSignature = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await stat(file, { bigint: true });
      return {
        signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
        size: info.size,
      };
    },
    catch: () => new CollectionError({ message: 'Usage file could not be read.' }),
  });

export const prepareParsedCache = Effect.fn('usage.prepareParsedCache')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(fs.chmod(directory, 0o700)),
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
});

export const parsedCachePath = (directory: string, harness: string, file: string) =>
  join(directory, `${createHash('sha256').update(`${harness}:${file}`).digest('hex')}.json`);

export const readParsedCache = Effect.fn('usage.readParsedCache')(function* (destination: string, signature: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* Effect.result(fs.readFileString(destination));
  if (Result.isFailure(contents)) return null;
  const decoded = yield* Effect.result(
    Effect.try({
      try: () => decodeCache(JSON.parse(contents.success)),
      catch: () => new CollectionError({ message: 'Cached usage metadata is invalid.' }),
    }),
  );
  if (Result.isFailure(decoded) || decoded.success.signature !== signature) return null;
  const cached = decoded.success.file;
  return {
    events: cached.events.map((entry) => ({ ...entry, event: { ...entry.event } })),
    malformed: cached.malformed,
    sessionId: cached.sessionId,
    parentId: cached.parentId,
    forkedAt: cached.forkedAt,
    compactionIds: new Set(cached.compactionIds),
  } satisfies ParsedFile;
});

export const writeParsedCache = Effect.fn('usage.writeParsedCache')(function* (
  destination: string,
  signature: string,
  file: ParsedFile,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const value = { version: 1, signature, file: { ...file, compactionIds: [...(file.compactionIds ?? [])] } };
  yield* fs.writeFileString(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }).pipe(
    Effect.andThen(fs.rename(temporary, destination)),
    Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.void))),
    // A missing/unwritable/corrupt cache must never hide source history.
    Effect.catch(() => Effect.void),
  );
});

export const pruneParsedCache = Effect.fn('usage.pruneParsedCache')(function* (
  directory: string,
  retained: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const listed = yield* Effect.result(fs.readDirectory(directory));
  if (Result.isFailure(listed)) return;
  for (const name of listed.success) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) || retained.has(name)) continue;
    // Moving/archiving logs creates a new path key. Remove obsolete metadata
    // files so the cache stays proportional to the current source inventory.
    yield* fs.remove(join(directory, name), { force: true }).pipe(Effect.catch(() => Effect.void));
  }
});
