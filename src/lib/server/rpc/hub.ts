import { Cache, Context, Effect, Exit, Layer, Schedule, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import type { Headers as EffectHeaders } from 'effect/http/Headers';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { UsageFailure, UsageRpc } from '../../shared/rpc';
import type { PricingPolicy } from '../../shared/pricing';
import { UsageQuery, type CollectionError, type UsageEvent, type UsageResult } from '../../shared/domain';
import { tokenTotal } from '../usage/parsers';
import { repriceEvent, resolveDisplayModel } from '../usage/pricing';
import { makePricingRuntime, pricingRefreshDue, sqlPricingStorage } from '../usage/pricing-store';
import { buildDashboard, eventMillis, matchesUsage, provider, usageTimeframe } from '../usage/dashboard';
import { ServerConfiguration, UsageStore } from './store';

// The hub serves the dashboard RPC and sync uploads on any host. A Bun hub also
// collects its own machine's logs; the Cloudflare hub has no local device.
export class LocalUsage extends Context.Service<
  LocalUsage,
  {
    readonly device?: { readonly id: string; readonly name: string; readonly platform: string };
    readonly collect: Effect.Effect<UsageResult, CollectionError>;
  }
>()('token-tracker/LocalUsage') {}

export const noLocalUsage = Layer.succeed(LocalUsage, {
  collect: Effect.succeed({ events: [], sources: [], warnings: [], pricingUpdatedAt: '' }),
});

export class HubPricing extends Context.Service<HubPricing, ReturnType<typeof makePricingRuntime>>()(
  'token-tracker/HubPricing',
) {}

// Hub state that lives entirely in one SQLite database: usage, devices, and
// pricing. The Cloudflare hub provides its Durable Object's SqlClient.
export const sqlHubServices = (pairingSecret: string) =>
  Layer.mergeAll(
    Layer.effect(UsageStore, UsageStore.make),
    Layer.effect(HubPricing, Effect.map(sqlPricingStorage(), makePricingRuntime)),
    noLocalUsage,
  ).pipe(Layer.provide(Layer.succeed(ServerConfiguration, { pairingSecret })));

export type HubOptions = {
  // A private (tailnet) hub lets its own same-origin dashboard edit pricing.
  // A public hub requires the pairing secret for every pricing change.
  readonly trustBrowser: boolean;
  readonly autoRefreshPricing: boolean;
};

// Store every device's copy for its own view, but count one native request when
// those logs have been copied between machines. Filtering precedes deduplication
// so a device remains independently inspectable.
const uniqueEvents = (events: readonly UsageEvent[], localDeviceId: string, query: UsageQuery) => {
  const records = new Map<string, UsageEvent>();
  for (const incoming of events) {
    if (query.devices && !query.devices.includes(incoming.deviceId ?? 'local')) continue;
    const key = `${incoming.harness}:${incoming.id}`;
    const existing = records.get(key);
    const preferredOwner =
      incoming.deviceId === localDeviceId ||
      (existing?.deviceId !== localDeviceId && (incoming.deviceId ?? '').localeCompare(existing?.deviceId ?? '') < 0);
    if (
      !existing ||
      tokenTotal(incoming) > tokenTotal(existing) ||
      (tokenTotal(incoming) === tokenTotal(existing) && preferredOwner)
    )
      records.set(key, incoming);
  }
  return [...records.values()];
};

const dashboardProofHeader = 'x-token-tracker-pricing-access';

export const rpcHandlersLayer = (browserProof: string, options: HubOptions) =>
  UsageRpc.toLayer(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const local = yield* LocalUsage;
      const pricing = yield* HubPricing;
      const localDeviceId = local.device?.id ?? '';
      if (options.autoRefreshPricing) {
        yield* pricing.load.pipe(
          Effect.flatMap((state) => (pricingRefreshDue(state.info) ? pricing.refresh : Effect.succeed(state))),
          Effect.catch(() => Effect.void),
          Effect.repeat(Schedule.spaced('1 hour')),
          Effect.forkScoped,
        );
      }
      const authorize = (secret: string, headers: EffectHeaders) =>
        options.trustBrowser && headers[dashboardProofHeader] === browserProof
          ? Effect.void
          : store.authorizePricing(secret);
      const effectiveQuery = (query: UsageQuery, policy: PricingPolicy): UsageQuery => ({
        ...query,
        models: query.models && [...new Set(query.models.map((model) => resolveDisplayModel(model, policy)))],
      });
      const decodeReadKey = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            query: UsageQuery,
            revision: Schema.Number,
            pricingRevision: Schema.optionalKey(Schema.String),
          }),
        ),
      );
      const readRawSnapshot = Effect.fn('rpc.readRawSnapshot')(function* (key: string) {
        const { query } = decodeReadKey(key);
        const timeframe = usageTimeframe(query);
        const current = yield* local.collect;
        const previousMillis = timeframe.previousStart.startOfDay().epochMilliseconds;
        const endMillis = timeframe.end.epochMilliseconds;
        const localCandidates = current.events
          .filter((event) => {
            const millis = Date.parse(event.timestamp);
            return millis >= previousMillis && millis < endMillis;
          })
          .map((event) => event.id);
        const [remote, dimensions] = yield* Effect.all(
          [
            store.getUsage(localDeviceId, {
              ...(timeframe.range !== 'all'
                ? {
                    start: timeframe.previousStart.startOfDay().toInstant().toString({ fractionalSecondDigits: 3 }),
                    end: timeframe.end.toInstant().toString({ fractionalSecondDigits: 3 }),
                  }
                : {}),
              devices: query.devices,
              candidateIds: localCandidates,
            }),
            store.getDimensions(localDeviceId),
          ],
          {
            concurrency: 2,
          },
        );
        return { remote, current, dimensions };
      });
      // A pricing edit invalidates calculated prices, not the underlying usage.
      // Reuse validated records so a save never rereads unchanged log history.
      const rawSnapshots = yield* Cache.makeWith(readRawSnapshot, {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? '5 seconds' : 0),
      });
      const readSnapshot = Effect.fn('rpc.readSnapshot')(function* (key: string) {
        const { query, revision } = decodeReadKey(key);
        const state = yield* pricing.load;
        const { remote, current, dimensions } = yield* Cache.get(rawSnapshots, JSON.stringify({ query, revision }));
        const unique = uniqueEvents([...remote.events, ...current.events], localDeviceId, query);
        const events: UsageEvent[] = [];
        for (let offset = 0; offset < unique.length; offset += 1_000) {
          for (const event of unique.slice(offset, offset + 1_000)) events.push(repriceEvent(event, state.policy));
          yield* Effect.yieldNow;
        }
        const policySnapshot = `${state.info.updatedAt} · ${state.info.revision.slice(0, 12)}`;
        const modern = (event: UsageEvent) =>
          event.serviceTier !== undefined && (event.cacheWriteTokens === 0 || event.cacheWrite1hTokens !== undefined);
        const legacyKeys = new Set<string>();
        for (const event of events)
          if (event.costKnown && !modern(event) && event.deviceId !== localDeviceId)
            legacyKeys.add(`${event.deviceId}:${event.id}`);
        const snapshotsByRecord = new Map<string, string>();
        if (legacyKeys.size)
          for (const snapshot of remote.pricingSnapshots) {
            const key = `${snapshot.deviceId}:${snapshot.eventId}`;
            if (legacyKeys.has(key)) snapshotsByRecord.set(key, snapshot.updatedAt);
          }
        const snapshotSet = new Set<string>();
        for (const event of events)
          if (event.costKnown)
            snapshotSet.add(
              (modern(event)
                ? policySnapshot
                : event.deviceId === localDeviceId
                  ? current.pricingUpdatedAt
                  : snapshotsByRecord.get(`${event.deviceId}:${event.id}`)) || 'unknown',
            );
        const snapshots = [...snapshotSet].sort();
        const pricingWarnings =
          snapshots.length > 1
            ? [
                `Usage includes different snapshots of model pricing (${snapshots.join(', ')}). Legacy synced records retain their reported cost until that machine syncs with the updated collector.`,
              ]
            : snapshots[0] === 'unknown'
              ? [
                  'Some legacy synced costs have no recorded pricing snapshot; they retain the prices reported by that machine.',
                ]
              : [];
        return {
          state,
          dimensions: [
            ...dimensions,
            ...current.events.map((event) => ({
              deviceId: event.deviceId ?? 'local',
              harness: event.harness,
              model: event.rawModel ?? event.model,
              project: event.repository ?? event.project,
            })),
          ],
          data: {
            events,
            sources: [...current.sources, ...remote.sources],
            warnings: [...current.warnings, ...remote.warnings, ...pricingWarnings],
            pricingUpdatedAt: snapshots.join(', ') || policySnapshot,
          },
        };
      });
      // Share concurrent dashboard/pricing reads and retain two bounded, short-
      // lived snapshots. Writes change the key immediately; failures are never cached.
      const snapshots = yield* Cache.makeWith(readSnapshot, {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? '5 seconds' : 0),
      });
      const readUsage = Effect.fn('rpc.readUsage')(function* (query: UsageQuery) {
        const state = yield* pricing.load;
        const result = yield* Cache.get(
          snapshots,
          JSON.stringify({
            query: {
              range: query.range ?? '30d',
              timezone: query.timezone ?? 'UTC',
              ...(query.devices ? { devices: [...query.devices].sort() } : {}),
            },
            revision: store.getRevision(),
            pricingRevision: state.policy.revision,
          }),
        );
        return { ...result, query: effectiveQuery(query, result.state.policy) };
      });
      return {
        GetUsage: Effect.fn('rpc.GetUsage')(
          function* (query) {
            const result = yield* readUsage(query);
            return yield* Effect.try({
              try: () => {
                const dashboard = buildDashboard(
                  result.data,
                  result.query,
                  new Date(),
                  local.device?.name ?? 'All devices',
                  result.state.policy,
                );
                const available = result.dimensions.filter(
                  (dimension) => !result.query.devices || result.query.devices.includes(dimension.deviceId),
                );
                const models = [
                  ...new Set(available.map((dimension) => resolveDisplayModel(dimension.model, result.state.policy))),
                ].sort();
                return {
                  ...dashboard,
                  pricing: {
                    ...dashboard.pricing,
                    method:
                      'API-equivalent cost from complete native Grok accounting, cached model prices, and saved pricing rules. Subscription charges may differ; unavailable costs are excluded.',
                  },
                  filters: {
                    harnesses: [...new Set(available.map((dimension) => dimension.harness))].sort(),
                    models,
                    providers: [...new Set(models.map(provider))].sort(),
                    projects: [...new Set(available.map((dimension) => dimension.project))].sort(),
                    modelProviders: models.map((model) => ({ model, provider: provider(model) })),
                    ...(result.query.models ? { selectedModels: result.query.models } : {}),
                    devices: [...new Set(result.dimensions.map((dimension) => dimension.deviceId))].sort(),
                  },
                };
              },
              catch: () => new UsageFailure({ message: 'The selected usage timeframe or timezone is invalid.' }),
            });
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetPricing: Effect.fn('rpc.GetPricing')(
          function* (query) {
            const result = yield* readUsage(query);
            const groups = new Map<string, { tokens: number; legacy: boolean }>();
            const now = new Date();
            const timeframe = usageTimeframe(result.query, now);
            const start = timeframe.start.epochMilliseconds;
            const end = Math.min(timeframe.end.epochMilliseconds, now.getTime() + 1);
            for (const event of result.data.events) {
              if (event.costKnown) continue;
              const millis = eventMillis(event);
              if ((timeframe.range !== 'all' && millis < start) || millis >= end || !matchesUsage(result.query, event))
                continue;
              const raw = event.rawModel ?? event.model;
              const group = groups.get(raw) ?? { tokens: 0, legacy: false };
              group.tokens += tokenTotal(event);
              group.legacy ||=
                event.serviceTier === undefined ||
                (event.cacheWriteTokens > 0 && event.cacheWrite1hTokens === undefined);
              groups.set(raw, group);
            }
            const unresolved = [...groups]
              .flatMap(([model, { tokens, legacy }]) => {
                if (!tokens) return [];
                return [
                  {
                    model,
                    tokens,
                    reason: legacy
                      ? 'This device needs to sync with the updated collector before all rates can be applied.'
                      : 'Choose an existing model or supply the missing input, output, cache, or service-tier rates.',
                  },
                ];
              })
              .sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model));
            return { info: result.state.info, unresolved, secretRequired: !options.trustBrowser };
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetPricingPolicy: Effect.fn('rpc.GetPricingPolicy')(function* ({ revision }) {
          const state = yield* pricing.load;
          return revision === state.policy.revision ? null : state.policy;
        }),
        SetPricingRule: Effect.fn('rpc.SetPricingRule')(function* ({ rule, adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* pricing.setRule(rule)).info;
        }),
        DeletePricingRule: Effect.fn('rpc.DeletePricingRule')(function* ({ model, adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* pricing.deleteRule(model)).info;
        }),
        RefreshPricing: Effect.fn('rpc.RefreshPricing')(function* ({ adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* pricing.refresh).info;
        }),
        GetDevices: Effect.fn('rpc.GetDevices')(function* () {
          const devices = yield* store.getDevices();
          const device = local.device;
          if (!device || devices.some((item) => item.id === device.id)) return devices;
          return [{ ...device, lastSeen: new Date().toISOString(), eventCount: 0 }, ...devices];
        }),
        RegisterDevice: ({ pairingSecret, device }) => store.registerDevice(pairingSecret, device),
        SyncUsage: ({ deviceId, token, batch }) => store.syncUsage(deviceId, token, batch),
        ImportUsage: ({ pairingSecret, batch }) => store.importUsage(pairingSecret, batch),
      };
    }),
  );

// One web handler for every host. Pricing proofs are per handler, and a
// forwarded RPC payload can never supply its own proof; only the guard attaches one.
export const makeHubWebHandler = <E>(
  services: Layer.Layer<UsageStore | LocalUsage | HubPricing, E>,
  options: HubOptions & { readonly expectedOrigin?: string },
  routes: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.empty,
) => {
  const browserProof = randomBytes(32).toString('hex');
  const rpc = RpcServer.layerHttp({ group: UsageRpc, path: '/rpc', protocol: 'http' }).pipe(
    Layer.provide(rpcHandlersLayer(browserProof, options).pipe(Layer.provide(services))),
    Layer.provide(RpcSerialization.layerNdjson),
  );
  const health = HttpRouter.add(
    'GET',
    '/api/health',
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const devices = yield* store.getDevices();
      return HttpServerResponse.jsonUnsafe({ status: 'ok', version: '0.4.0', devices: devices.length });
    }).pipe(
      Effect.catchTag('StorageFailure', () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ status: 'unavailable' }, { status: 503 })),
      ),
    ),
  ).pipe(HttpRouter.provideRequest(services));
  const web = HttpRouter.toWebHandler(Layer.mergeAll(rpc, health, routes), { disableLogger: true });
  return {
    ...web,
    handler: (request: Request) => {
      // Trust only a genuine same-origin browser POST; never return the pairing
      // secret or let an RPC payload supply its own browser authorization proof.
      const headers = new Headers(request.headers);
      headers.delete(dashboardProofHeader);
      const origin = headers.get('origin');
      if (origin && origin !== (options.expectedOrigin ?? new URL(request.url).origin)) {
        return Promise.resolve(new Response('Cross-origin requests are not allowed.', { status: 403 }));
      }
      if (origin) headers.set(dashboardProofHeader, browserProof);
      return web.handler(new Request(request, { headers }));
    },
  };
};
