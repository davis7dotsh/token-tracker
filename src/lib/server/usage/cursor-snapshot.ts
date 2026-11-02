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
export const readCursorSnapshot = Effect.fn('usage.readCursorSnapshot')(function* (path = cursorSnapshotPath()) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* Effect.result(fs.readFileString(path));
  if (Result.isFailure(result)) {
    if (result.failure.reason._tag === 'NotFound') return null;
    return yield* Effect.fail(new CollectionError({ message: 'Could not read the Cursor usage snapshot.' }));
  }
  return yield* decode(result.success).pipe(
    Effect.mapError(
      () =>
        new CollectionError({
          message: 'Invalid Cursor usage snapshot. Restore it from backup or move it aside and run cursor sync.',
        }),
    ),
  );
});
