import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { SqliteClient } from '@effect/sql-sqlite-do';
import * as Cloudflare from 'alchemy/Cloudflare';
import { Config, Context, Effect, Layer, Redacted, Scheduler, Schema } from 'effect';
import { HttpServerRequest, toWeb } from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { SqlClient } from 'effect/sql';
import { makeHubWebHandler, sqlHubServices } from '../lib/server/rpc/hub';

// Bound to the Hub Worker as a secret at deploy time; never stored in the repo.
const pairingSecret = Config.schema(
  Schema.Redacted(Schema.String.check(Schema.isMinLength(16))),
  'TOKEN_TRACKER_PAIRING_SECRET',
);

// Durable Object storage transactions hold the input gate, which can also
// delay timers. Yield through microtasks inside transactions, as alchemy's own
// Durable Object SQL integration does.
const durableObjectSql = (storage: DurableObjectStorage) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const services = yield* Layer.build(SqliteClient.layer({ storage }));
      const client = Context.get(services, SqliteClient.SqliteClient);
      const original = client.withTransaction;
      const scheduler = new Scheduler.MixedScheduler('sync');
      const withTransaction: typeof client.withTransaction = (body) =>
        original(body).pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
      return Object.assign(client, { withTransaction });
    }),
  );

// One named instance is the single writer for every device's usage, matching
// the self-hosted Bun hub's one-process database ownership.
export class Hub extends Cloudflare.DurableObject<Hub>()(
  'Hub',
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const secret = yield* pairingSecret.pipe(Effect.orDie);
      const hub = makeHubWebHandler(
        sqlHubServices(Redacted.value(secret)).pipe(Layer.provide(durableObjectSql(state.raw.storage))),
        // Dashboard sessions gate reads; pricing administration still uses
        // the separate pairing secret. Collectors never gain dashboard access.
        { trustBrowser: false, autoRefreshPricing: true },
      );
      return {
        fetch: Effect.gen(function* () {
          const request = yield* toWeb(yield* HttpServerRequest);
          return HttpServerResponse.fromWeb(yield* Effect.promise(() => hub.handler(request)));
        }),
      };
    });
  }),
) {}

// Reachable only through the dashboard's service binding.
export default class HubWorker extends Cloudflare.Worker<HubWorker>()(
  'HubWorker',
  { main: import.meta.url, workersDev: false },
  Effect.gen(function* () {
    yield* pairingSecret;
    const hubs = yield* Hub;
    return {
      fetch: Effect.gen(function* () {
        return yield* hubs.getByName('hub').fetch(yield* HttpServerRequest);
      }),
    };
  }),
) {}
