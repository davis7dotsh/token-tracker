import { Clock, Effect } from 'effect';
import type { UsageQuery } from '../../shared/domain';

// Self-hosted only: remember a range and timezone, never rows, filters, or credentials.
export type ViewHints = {
  read: () => Promise<UsageQuery | undefined>;
  remember: (range: 'today' | '7d' | '30d', timezone: string) => Promise<void>;
};

export const makeViewWarmer = Effect.fn('rpc.viewWarmer')(function* (
  hints: ViewHints | undefined,
  prepare: (query: UsageQuery) => Effect.Effect<unknown, unknown>,
  revision: () => number,
) {
  const scope = yield* Effect.scope;
  let recent: { query: UsageQuery; until: number } | undefined;
  let scheduled = false;
  const ignoreFailure = (run: () => Promise<unknown>) => Effect.tryPromise(run).pipe(Effect.ignore);
  if (hints) {
    // The hub starts on first traffic (including health checks and uploads).
    // Previously visited hubs can prepare the landing view before a browser connects.
    yield* Effect.tryPromise(hints.read).pipe(
      Effect.flatMap((query) => (query ? prepare(query) : Effect.void)),
      Effect.ignore,
      Effect.forkIn(scope),
    );
  }
  const visited = Effect.fnUntraced(function* (query: UsageQuery) {
    if (!hints) return;
    const range = query.range ?? '30d';
    if (range !== 'today' && range !== '7d' && range !== '30d') {
      recent = undefined;
      return;
    }
    recent = { query, until: (yield* Clock.currentTimeMillis) + 5 * 60_000 };
    yield* ignoreFailure(() => hints.remember(range, query.timezone ?? 'UTC')).pipe(Effect.forkIn(scope));
  });
  const changed = Effect.fnUntraced(function* (ack: { accepted: number; updated: number; deleted: number }) {
    if (!recent || scheduled || !(ack.accepted || ack.updated || ack.deleted)) return;
    if ((yield* Clock.currentTimeMillis) >= recent.until) {
      recent = undefined;
      return;
    }
    scheduled = true;
    // One worker per hub, not one per upload batch. Coalesce bursts, never
    // delay the ACK or make a foreground reader wait for a debounce timer.
    yield* Effect.gen(function* () {
      while (recent) {
        const before = revision();
        yield* Effect.sleep('2 seconds');
        if (!recent || (yield* Clock.currentTimeMillis) >= recent.until) break;
        if (before !== revision()) continue;
        yield* prepare(recent.query);
        if (before === revision()) break;
      }
    }).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          scheduled = false;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  return { visited, changed };
});
