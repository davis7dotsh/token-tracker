import { expect, test } from 'bun:test';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { makeDayPacks, retainedDays, type DayPacks } from '../../src/lib/server/rpc/day-packs';

const first = '2026-01-01';
const second = '2026-01-02';
const row = (day: string) => ({
  id: day,
  device_id: 'source',
  timestamp: `${day}T12:00:00.000Z`,
  pricing_snapshot: 'snapshot',
  payload: '{}',
});
const withPacks = <A, E>(run: (packs: DayPacks, sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE usage_events(id TEXT PRIMARY KEY, timestamp TEXT NOT NULL)`;
      const packs = yield* makeDayPacks(sql, {
        compress: async (text) => Buffer.from(text),
        decompress: async (bytes) => Buffer.from(bytes).toString('utf8'),
      });
      return yield* run(packs, sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' }))),
  );

test('a cross-day upsert invalidates both packs on commit and neither on rollback', () =>
  withPacks((packs, sql) =>
    Effect.gen(function* () {
      for (const day of [first, second]) yield* sql`INSERT INTO usage_events VALUES (${day}, ${row(day).timestamp})`;
      const fill = yield* packs.begin([first, second], first, 'excluded');
      for (const day of [first, second]) yield* fill.save(day, [row(day)]);
      yield* fill.flush();
      const move = sql`INSERT INTO usage_events VALUES (${first}, ${row(second).timestamp})
        ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp`;
      yield* sql.withTransaction(move.pipe(Effect.andThen(Effect.fail('rollback')))).pipe(Effect.ignore);
      for (const day of [first, second]) expect(yield* packs.lookup(day, 'excluded')).toEqual([row(day)]);
      yield* move;
      for (const day of [first, second]) expect(yield* packs.lookup(day, 'excluded')).toBeUndefined();
    }),
  ));

test('delayed compressed results cannot overwrite a competing fill or revive a changed or evicted day', () =>
  withPacks((packs, sql) =>
    Effect.gen(function* () {
      const stale = yield* packs.begin([first, second], first, 'old-scope');
      for (const day of [first, second]) yield* stale.save(day, [row(day)]);
      // Compression has finished, but the batched publication has not. A new
      // scope takes over one ticket while a collector invalidates the other.
      const current = yield* packs.begin([first], first, 'new-scope');
      yield* current.save(first, [row(first)]);
      yield* current.flush();
      yield* sql`INSERT INTO usage_events VALUES (${second}, ${row(second).timestamp})`;
      yield* stale.flush();
      expect(yield* packs.lookup(first, 'old-scope')).toBeUndefined();
      expect(yield* packs.lookup(first, 'new-scope')).toEqual([row(first)]);
      expect(yield* packs.lookup(second, 'old-scope')).toBeUndefined();

      const evicted = yield* packs.begin([first], first, 'new-scope');
      yield* evicted.save(first, [row(first)]);
      const newer = Array.from({ length: retainedDays }, (_, i) =>
        new Date(Date.UTC(2026, 1, i + 1)).toISOString().slice(0, 10),
      );
      yield* packs.begin(newer, newer[0], 'new-scope');
      yield* evicted.flush();
      expect(yield* packs.lookup(first, 'new-scope')).toBeUndefined();
    }),
  ));
