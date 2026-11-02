import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, FileSystem, Result, Schema } from 'effect';
import { CollectionError, UsageEvent } from '../../shared/domain';
import { configDirectory } from '../rpc/identity';

export const cursorSnapshotName = 'cursor-usage.json';
export const cursorSnapshotPath = (home?: string) =>
  join(configDirectory(process.platform, process.env, home), cursorSnapshotName);

// This file is an accounting source, not a connection configuration. The hub
// and read-only commands never open the key file or contact Cursor.
const cursorId = Schema.String.check(Schema.isStartingWith('cursor:'));
export const CursorSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  syncedAt: UsageEvent.fields.timestamp,
  events: Schema.Array(
    UsageEvent.check(Schema.makeFilter((event) => event.harness === 'cursor' && event.id.startsWith('cursor:'))),
  ),
  warnings: Schema.Array(Schema.String),
  retractedIds: Schema.optionalKey(Schema.Array(cursorId)),
});
export type CursorSnapshot = typeof CursorSnapshot.Type;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorSnapshot));
// A busy local harness may invalidate the combined dashboard while the
// imported Cursor history is unchanged. Reuse just one validated snapshot;
// large imports still work, but don't pin a second large history in memory.
let cached: { path: string; signature: string; value: CursorSnapshot } | undefined;
const observe = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const s = await stat(path, { bigint: true });
        return s.size <= 8n * 1024n * 1024n ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    catch: () => new CollectionError({ message: 'Could not inspect the Cursor usage snapshot.' }),
  });
export const readCursorSnapshot = Effect.fn('usage.readCursorSnapshot')(function* (path = cursorSnapshotPath()) {
  const signature = yield* observe(path);
  if (signature && cached && cached.path === path && cached.signature === signature) return cached.value;
  if (cached?.path === path) cached = undefined;
  if (signature === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.readFileString(path));
  if (Result.isFailure(result)) {
    if (result.failure.reason._tag === 'NotFound') return null;
    return yield* Effect.fail(new CollectionError({ message: 'Could not read the Cursor usage snapshot.' }));
  }
  const value = yield* decode(result.success).pipe(
    Effect.mapError(
      () =>
        new CollectionError({
          message: 'Invalid Cursor usage snapshot. Restore it from backup or move it aside and run cursor sync.',
        }),
    ),
  );
  // Never label a racing replacement with a fingerprint from before the read.
  if (signature && (yield* observe(path)) === signature) cached = { path, signature, value };
  return value;
});
