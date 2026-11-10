import { expect, test } from 'bun:test';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { makeDayPacks, retainedDays, type DayPacks } from '../../src/lib/server/rpc/day-packs';

const materialize = <A>(rows: Iterable<A> | undefined) => rows && [...rows];
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
        compress: async (bytes) => bytes,
        decompress: async (bytes) => bytes,
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
      for (const day of [first, second]) expect(materialize(yield* packs.lookup(day, 'excluded'))).toEqual([row(day)]);
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
      expect(materialize(yield* packs.lookup(first, 'new-scope'))).toEqual([row(first)]);
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

test('v1 packs round-trip Unicode and quoted metadata byte-for-byte and reject mismatched line counts', () =>
  withPacks((packs, sql) =>
    Effect.gen(function* () {
      const rows = [
        { ...row(first), id: '雪\n"', payload: '{"title":"cafés ☕️ and 😀"}' },
        { ...row(first), id: 'line\\two', payload: '{"title":"one\\ntwo"}' },
      ];
      // Text encoder used by older releases: one JSON header, then one line per payload.
      const header = JSON.stringify(rows.map((r) => [r.id, r.device_id, r.pricing_snapshot, r.timestamp]));
      const v1 = Buffer.from([header, ...rows.map((r) => r.payload)].join('\n'));
      yield* sql`INSERT INTO usage_day_packs_v1 VALUES (${first}, '', 'old-ticket', ${v1})`;
      expect(materialize(yield* packs.lookup(first, ''))).toEqual(rows);
      const fill = yield* packs.begin([first], first, '');
      yield* fill.save(first, rows);
      yield* fill.flush();
      const [saved] = yield* sql<{ body: Uint8Array }>`SELECT body FROM usage_day_packs_v1 WHERE day = ${first}`;
      expect(Buffer.from(saved.body).equals(v1)).toBe(true);
      for (const text of [header, header + '\n{}', v1.toString('utf8') + '\n{}']) {
        yield* sql`UPDATE usage_day_packs_v1 SET body = ${Buffer.from(text)} WHERE day = ${first}`;
        expect(yield* packs.lookup(first, '')).toBeUndefined();
      }
    }),
  ));

test('a clipped pack uses half-open indexed UTC bounds and preserves timestamp ties', () =>
  withPacks((packs, sql) =>
    Effect.gen(function* () {
      const at = (time: string) => `${first}T${time}:00:00.000Z`;
      const rows = ['02', ...Array.from({ length: 128 }, () => '08'), '20'].map((hour, i) => ({
        ...row(first),
        id: String(i),
        timestamp: at(hour),
        // Payload timestamps may have different offsets than the UTC index.
        payload: JSON.stringify({ timestamp: `${first}T00:00:00-08:00` }),
      }));
      yield* sql`CREATE INDEX usage_events_timestamp ON usage_events(timestamp)`;
      // 128 index hits at 08:00 qualify the dense slice; the lone 20:00 hit does not.
      yield* sql`INSERT INTO usage_events SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
        FROM json_each(${JSON.stringify(rows.map((r) => [r.id, r.timestamp]))})`;
      const fill = yield* packs.begin([first], first, 'local');
      yield* fill.save(first, rows);
      yield* fill.flush();
      const bounds = { from: at('08'), until: at('20') };
      expect(materialize(yield* packs.lookup(first, 'local', bounds))).toEqual(rows.slice(1, -1));
      expect(yield* packs.lookup(first, 'other', bounds)).toBeUndefined();
      expect(yield* packs.lookup(first, 'local', { from: at('12'), until: first + 'U' })).toBeUndefined();
      expect(materialize(yield* packs.lookup(first, 'local'))).toEqual(rows);
    }),
  ));
