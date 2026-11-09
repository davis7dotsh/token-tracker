import { expect, test } from 'bun:test';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { makeViewWarmer } from '../../src/lib/server/rpc/view-warmer';
import type { UsageQuery } from '../../src/lib/shared/domain';

test('a recent page warms once after a burst of writes, but never on heartbeats or after idle', async () => {
  const prepared: UsageQuery[] = [];
  const query = { range: '30d', timezone: 'America/New_York', projects: ['one'] } as const;
  let revision = 1;
  await Effect.runPromise(
    Effect.gen(function* () {
      const warmer = yield* makeViewWarmer(
        { read: () => Promise.resolve(undefined), remember: () => Promise.resolve() },
        (next) => Effect.sync(() => prepared.push(next)),
        () => revision,
      );
      yield* warmer.visited(query);
      yield* warmer.changed({ accepted: 1, updated: 0, deleted: 0 });
      yield* TestClock.adjust('1 second');
      revision++;
      yield* warmer.changed({ accepted: 0, updated: 0, deleted: 1 });
      yield* TestClock.adjust('1 second');
      expect(prepared).toEqual([]);
      yield* TestClock.adjust('3 seconds');
      expect(prepared).toEqual([query]);
      yield* warmer.changed({ accepted: 0, updated: 0, deleted: 0 });
      yield* TestClock.adjust('6 minutes');
      yield* warmer.changed({ accepted: 0, updated: 1, deleted: 0 });
      yield* TestClock.adjust('4 seconds');
      expect(prepared).toEqual([query]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
