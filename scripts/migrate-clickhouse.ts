import { BunRuntime } from '@effect/platform-bun';
import { Database } from 'bun:sqlite';
import { Console, Data, Effect, Schema } from 'effect';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clickHouseConfigFromEnv, makeClickHouseClient } from '../src/lib/server/rpc/clickhouse';
import {
  eventToRow,
  formatTimestamp,
  migrationVersion,
  schemaStatements,
} from '../src/lib/server/rpc/clickhouse-schema';
import { UsageEvent } from '../src/lib/shared/domain';

// EXPERIMENTAL: copies a self-hosted hub's SQLite devices and usage records into
// ClickHouse (see the README's ClickHouse section), preserving record IDs,
// payload hashes, pricing snapshots, and device token hashes, so collectors keep
// syncing without re-pairing and unchanged records still deduplicate.
//
//   bun scripts/migrate-clickhouse.ts [data dir] [--allow-skips]
//
// The SQLite database is opened read-only. Rerunning is safe: migrated rows get
// deterministic versions (devices 1, records their own timestamp), so a rerun
// writes identical rows, and anything a live ClickHouse hub has written since
// carries a newer version and wins.
//
// Records that cannot be converted are skipped and listed as deviceId:id, and
// the script then exits non-zero because the target is incomplete. Pass
// --allow-skips to accept that loss and exit 0.
class MigrationFailure extends Data.TaggedError('MigrationFailure')<{ readonly message: string }> {}

const args = process.argv.slice(2);
const allowSkips = args.includes('--allow-skips');
const dataDirectory = resolve(
  args.find((arg) => !arg.startsWith('--')) ??
    process.env.TOKEN_TRACKER_DATA_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'token-tracker'),
);
const databasePath = join(dataDirectory, 'usage.sqlite');
const pageSize = 1_000;
const listedSkips = 20;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(UsageEvent));

const migrate = Effect.gen(function* () {
  if (!existsSync(databasePath)) return yield* new MigrationFailure({ message: `No hub database at ${databasePath}.` });
  const config = clickHouseConfigFromEnv();
  const clickhouse = yield* Effect.try({
    try: () => makeClickHouseClient(config),
    catch: (cause) => new MigrationFailure({ message: String(cause) }),
  });
  const request = <A>(evaluate: () => Promise<A>) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new MigrationFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
  for (const statement of schemaStatements(clickhouse.database))
    yield* request(() => clickhouse.command(statement, { database: 'default' }));

  const sqlite = yield* Effect.acquireRelease(
    Effect.sync(() => new Database(databasePath, { readonly: true })),
    (database) => Effect.sync(() => database.close()),
  );
  const tables = new Set(
    sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (!tables.has('devices') || !tables.has('usage_events'))
    return yield* new MigrationFailure({ message: `${databasePath} has no hub tables yet. Nothing to migrate.` });

  const devices = sqlite
    .query<
      {
        id: string;
        name: string;
        platform: string;
        token_hash: string;
        last_seen: string | null;
        sources: string;
        pricing_updated_at: string;
        revoked_at: string | null;
      },
      []
    >('SELECT id, name, platform, token_hash, last_seen, sources, pricing_updated_at, revoked_at FROM devices')
    .all();
  yield* request(() =>
    clickhouse.insert(
      'devices',
      devices.map((device) => ({
        ...device,
        last_seen: device.last_seen && formatTimestamp(device.last_seen),
        revoked_at: device.revoked_at && formatTimestamp(device.revoked_at),
        version: 1n,
      })),
    ),
  );
  yield* Console.log(`Copied ${devices.length} devices to ${config.url} (${clickhouse.database}).`);

  const page = sqlite.query<
    { rowid: number; id: string; device_id: string; payload: string; payload_hash: string; pricing_snapshot: string },
    [number, number]
  >(
    'SELECT rowid, id, device_id, payload, payload_hash, pricing_snapshot FROM usage_events WHERE rowid > ? ORDER BY rowid LIMIT ?',
  );
  let after = 0;
  let copied = 0;
  const skipped: string[] = [];
  while (true) {
    const rows = page.all(after, pageSize);
    if (!rows.length) break;
    after = rows[rows.length - 1].rowid;
    const converted = rows.flatMap((row) => {
      try {
        const event = decodeEvent(row.payload);
        return [
          eventToRow(event, row.device_id, migrationVersion(event.timestamp), row.pricing_snapshot, row.payload_hash),
        ];
      } catch {
        // Never print payloads: they hold project paths and session titles.
        skipped.push(`${row.device_id}:${row.id}`);
        return [];
      }
    });
    yield* request(() => clickhouse.insert('usage_events', converted));
    copied += converted.length;
    yield* Console.log(`${copied.toLocaleString('en-US')} records copied`);
  }
  yield* Console.log(
    `Done: ${devices.length} devices, ${copied.toLocaleString('en-US')} records copied, ${skipped.length.toLocaleString('en-US')} unreadable records skipped.`,
  );
  if (!skipped.length) return;
  for (const record of skipped.slice(0, listedSkips)) yield* Console.log(`  skipped ${record}`);
  if (skipped.length > listedSkips)
    yield* Console.log(`  …and ${(skipped.length - listedSkips).toLocaleString('en-US')} more`);
  if (!allowSkips)
    return yield* new MigrationFailure({
      message: `${skipped.length} records were not copied. Fix them in SQLite and rerun, or pass --allow-skips to accept the loss.`,
    });
});

migrate.pipe(Effect.scoped, BunRuntime.runMain);
