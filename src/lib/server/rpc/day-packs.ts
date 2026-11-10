import { Effect } from 'effect';
import type { SqlClient } from 'effect/sql';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { StoredRow } from './window-pages';

// Only the Bun hub supplies a codec. Packs are disposable copies of raw SQL
// rows, never prices, aggregates, or a substitute for validating each event.
export type DayPackCodec = {
  compress: (bytes: Uint8Array) => Promise<Uint8Array>;
  decompress: (bytes: Uint8Array, limit: number) => Promise<Uint8Array>;
};
const maxRaw = 48 * 1024 * 1024;
const maxPacked = 4 * 1024 * 1024;
const maxRows = 65_536;
export const retainedDays = 64;
const isMeta = (m: unknown): m is [string, string, string, string] =>
  Array.isArray(m) && m.length === 4 && m.every((v: unknown) => typeof v === 'string');
const unpack = (raw: Uint8Array): Iterable<StoredRow> => {
  if (raw.byteLength > maxRaw) throw new Error('Invalid day pack');
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerEnd = bytes.indexOf(10);
  if (headerEnd < 0) throw new Error('Invalid day pack');
  const metadata: unknown = JSON.parse(bytes.toString('utf8', 0, headerEnd));
  if (!Array.isArray(metadata) || !metadata.length || metadata.length > maxRows || !metadata.every(isMeta))
    throw new Error('Invalid day pack');
  // Validate the entire v1 frame before offering it to a reader. Keep only
  // offsets: a day's payload strings need not coexist with the decoded events.
  const starts = new Uint32Array(metadata.length + 1);
  starts[0] = headerEnd + 1;
  for (let i = 0; i < metadata.length; i++) {
    const newline = bytes.indexOf(10, starts[i]);
    if ((newline === -1) !== (i === metadata.length - 1)) throw new Error('Invalid day pack');
    starts[i + 1] = (newline === -1 ? bytes.length : newline) + 1;
  }
  return {
    *[Symbol.iterator]() {
      for (let i = 0; i < metadata.length; i++) {
        const [id, device_id, pricing_snapshot, timestamp] = metadata[i];
        yield {
          id,
          device_id,
          pricing_snapshot,
          timestamp,
          payload: bytes.toString('utf8', starts[i], starts[i + 1] - 1),
        };
      }
    },
  };
};
const pack = (rows: readonly StoredRow[]) => {
  if (!rows.length || rows.length > maxRows) return;
  let payloadBytes = 0;
  let minHeader = 1;
  for (const row of rows) {
    payloadBytes += Buffer.byteLength(row.payload) + 1; // newline before each payload
    minHeader +=
      Buffer.byteLength(row.id) +
      Buffer.byteLength(row.device_id) +
      Buffer.byteLength(row.pricing_snapshot) +
      Buffer.byteLength(row.timestamp) +
      14;
    if (payloadBytes + minHeader > maxRaw || row.payload.includes('\n')) return;
  }
  const header = JSON.stringify(rows.map((row) => [row.id, row.device_id, row.pricing_snapshot, row.timestamp]));
  const size = Buffer.byteLength(header) + payloadBytes;
  if (size > maxRaw) return;
  const bytes = Buffer.allocUnsafe(size);
  let pos = bytes.write(header);
  for (const row of rows) {
    bytes[pos++] = 10;
    pos += bytes.write(row.payload, pos);
  }
  return bytes;
};

export const makeDayPacks = Effect.fn('UsageStore.makeDayPacks')(function* (
  sql: SqlClient.SqlClient,
  codec: DayPackCodec,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS usage_day_packs_v1 (
      day TEXT PRIMARY KEY, excluded TEXT NOT NULL, ticket TEXT NOT NULL, body BLOB) WITHOUT ROWID`);
      const invalidate = (row: 'OLD' | 'NEW') =>
        `DELETE FROM usage_day_packs_v1 WHERE day = substr(${row}.timestamp, 1, instr(${row}.timestamp,'T') - 1);`;
      // Keep invalidation in the database: previous binaries using INSERT/UPDATE/DELETE/UPSERT must
      // also invalidate packs, even across rollback/re-upgrade and process crashes.
      for (const [op, body] of [
        ['INSERT', invalidate('NEW')],
        ['DELETE', invalidate('OLD')],
        ['UPDATE', invalidate('OLD') + invalidate('NEW')],
      ])
        yield* sql.unsafe(
          `CREATE TRIGGER IF NOT EXISTS usage_day_packs_v1_${op} AFTER ${op} ON usage_events BEGIN ${body} END`,
        );
    }),
  );
  const lookup = Effect.fnUntraced(
    function* (day: string, excluded: string) {
      const rows = yield* sql<{
        body: Uint8Array;
      }>`SELECT body FROM usage_day_packs_v1 WHERE day = ${day} AND excluded = ${excluded} AND length(body) BETWEEN 1 AND ${maxPacked}`;
      if (rows.length)
        return yield* Effect.tryPromise(async () => unpack(await codec.decompress(rows[0].body, maxRaw)));
    },
    Effect.catch(() => Effect.succeed(undefined)),
  );
  // Claim missing days together, not a durable commit per day. Never hold a
  // write transaction while reading source rows, validating or compressing.
  const begin = Effect.fnUntraced(function* (days: readonly string[], firstMiss: string, excluded: string) {
    const ticket = randomBytes(16).toString('hex');
    const reserved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const claimed = yield* sql.unsafe<{ day: string }>(
            `INSERT INTO usage_day_packs_v1(day, excluded, ticket)
        SELECT value, ?, ? FROM json_each(?) WHERE true ON CONFLICT(day) DO UPDATE SET excluded = excluded.excluded,
        ticket = excluded.ticket, body = NULL WHERE day = ? OR body IS NULL OR usage_day_packs_v1.excluded <> excluded.excluded RETURNING day`,
            [excluded, ticket, JSON.stringify(days), firstMiss],
          );
          yield* sql.unsafe(
            `DELETE FROM usage_day_packs_v1 WHERE day IN (SELECT day FROM usage_day_packs_v1 ORDER BY day DESC LIMIT -1 OFFSET ${retainedDays})`,
          );
          return new Set(claimed.map((row) => row.day));
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(new Set<string>())));
    const pending = new Map<string, Uint8Array>();
    let bytes = 0;
    const flush = Effect.fnUntraced(function* () {
      if (!pending.size) return;
      yield* sql
        .withTransaction(
          Effect.forEach(
            pending,
            ([day, body]) =>
              sql`UPDATE usage_day_packs_v1 SET body = ${body} WHERE day = ${day} AND ticket = ${ticket}`,
            { discard: true },
          ),
        )
        .pipe(Effect.ignore);
      bytes = 0;
      pending.clear();
    });
    const save = Effect.fnUntraced(function* (day: string, rows: readonly StoredRow[]) {
      if (!reserved.has(day)) return;
      const body = yield* Effect.tryPromise(async () => {
        const raw = pack(rows);
        return raw ? codec.compress(raw) : undefined;
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      // A collector edit, eviction, or competing fill removes this ticket.
      if (body && body.byteLength <= maxPacked) {
        bytes += body.byteLength;
        pending.set(day, body);
        if (bytes >= maxPacked || pending.size >= 12) yield* flush();
      }
    });
    return { save, flush };
  });
  return { lookup, begin };
});
export type DayPacks = Effect.Success<ReturnType<typeof makeDayPacks>>;
