import { BunHttpPlatform, BunServices } from '@effect/platform-bun';
import { Cache, Context, Effect, Exit, FileSystem, Layer, Path, Result, Schedule, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import type { Headers as EffectHeaders } from 'effect/http/Headers';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { UsageFailure, UsageRpc } from '../../shared/rpc';
import type { PricingPolicy } from '../../shared/pricing';
import {
  deletePricingRule,
  loadPricing,
  pricingRefreshDue,
  refreshPricing,
  setPricingRule,
} from '../usage/pricing-runtime';
import { repriceEvent, resolveDisplayModel } from '../usage/pricing';
import { UsageQuery, type UsageEvent } from '../../shared/domain';
import { collectUsage, buildDashboard, tokenTotal } from '../usage';
import { getLocalDevice } from './identity';
import { UsageStore, usageStoreLayer, type ServerOptions } from './store';
import { eventMillis, matchesUsage, provider, usageTimeframe } from '../usage/dashboard';

export class LocalUsage extends Context.Service<LocalUsage>()('token-tracker/LocalUsage', {
  make: Effect.gen(function* () {
    const device = yield* getLocalDevice();
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const collect = collectUsage({
      deviceId: device.id,
      cacheDirectory: path.join(
        process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'),
        'token-tracker',
        'dashboard',
      ),
    }).pipe(Effect.provideService(FileSystem.FileSystem, filesystem), Effect.provideService(Path.Path, path));
    return { device, collect };
  }),
}) {}

export const localUsageLayer = Layer.effect(LocalUsage, LocalUsage.make).pipe(Layer.provide(BunServices.layer));

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

export const rpcHandlersLayer = (browserProof: string, autoRefreshPricing: boolean) =>
  UsageRpc.toLayer(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const local = yield* LocalUsage;
      const directory = store.pricingDirectory;
      if (autoRefreshPricing) {
        yield* loadPricing(directory).pipe(
          Effect.flatMap((state) =>
            pricingRefreshDue(state.info) ? refreshPricing(directory) : Effect.succeed(state),
          ),
          Effect.catch(() => Effect.void),
          Effect.repeat(Schedule.spaced('1 hour')),
          Effect.forkScoped,
        );
      }
      const authorize = (secret: string, headers: EffectHeaders) =>
        headers[dashboardProofHeader] === browserProof ? Effect.void : store.authorizePricing(secret);
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
            store.getUsage(local.device.id, {
              ...(timeframe.range !== 'all'
                ? {
                    start: timeframe.previousStart.startOfDay().toInstant().toString({ fractionalSecondDigits: 3 }),
                    end: timeframe.end.toInstant().toString({ fractionalSecondDigits: 3 }),
                  }
                : {}),
              devices: query.devices,
              candidateIds: localCandidates,
            }),
            store.getDimensions(local.device.id),
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
        const state = yield* loadPricing(directory);
        const { remote, current, dimensions } = yield* Cache.get(rawSnapshots, JSON.stringify({ query, revision }));
        const unique = uniqueEvents([...remote.events, ...current.events], local.device.id, query);
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
          if (event.costKnown && !modern(event) && event.deviceId !== local.device.id)
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
                : event.deviceId === local.device.id
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
        const state = yield* loadPricing(directory);
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
                  local.device.name,
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
            return { info: result.state.info, unresolved };
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetPricingPolicy: Effect.fn('rpc.GetPricingPolicy')(function* ({ revision }) {
          const state = yield* loadPricing(directory);
          return revision === state.policy.revision ? null : state.policy;
        }),
        SetPricingRule: Effect.fn('rpc.SetPricingRule')(function* ({ rule, adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* setPricingRule(rule, directory)).info;
        }),
        DeletePricingRule: Effect.fn('rpc.DeletePricingRule')(function* ({ model, adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* deletePricingRule(model, directory)).info;
        }),
        RefreshPricing: Effect.fn('rpc.RefreshPricing')(function* ({ adminSecret }, { headers }) {
          yield* authorize(adminSecret, headers);
          return (yield* refreshPricing(directory)).info;
        }),
        GetDevices: Effect.fn('rpc.GetDevices')(function* () {
          const devices = yield* store.getDevices();
          if (devices.some((device) => device.id === local.device.id)) return devices;
          return [{ ...local.device, lastSeen: new Date().toISOString(), eventCount: 0 }, ...devices];
        }),
        RegisterDevice: ({ pairingSecret, device }) => store.registerDevice(pairingSecret, device),
        SyncUsage: ({ deviceId, token, batch }) => store.syncUsage(deviceId, token, batch),
      };
    }),
  );

export const makeRpcWebHandler = (options: ServerOptions = {}, localLayer = localUsageLayer) => {
  const services = Layer.mergeAll(usageStoreLayer(options), localLayer);
  // adapter-node may reconstruct HTTP requests with an HTTPS scheme. Use the
  // deployment's explicit public origin when one is configured.
  const publicOrigin = options.dashboardOrigin ?? process.env.ORIGIN?.trim();
  const expectedOrigin = publicOrigin ? new URL(publicOrigin).origin : undefined;
  const browserProof = randomBytes(32).toString('hex');
  const handlers = rpcHandlersLayer(browserProof, options.autoRefreshPricing ?? localLayer === localUsageLayer).pipe(
    Layer.provide(services),
  );
  const rpc = RpcServer.layerHttp({ group: UsageRpc, path: '/rpc', protocol: 'http' }).pipe(
    Layer.provide(handlers),
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
  const downloads = HttpRouter.add(
    'GET',
    '/downloads/:file',
    Effect.gen(function* () {
      const { file } = yield* HttpRouter.params;
      const directory = process.env.TOKEN_TRACKER_DOWNLOAD_DIR?.trim();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const notFound = HttpServerResponse.empty({ status: 404 });
      const allowed = new Set([
        'token-tracker-0.3.0.tgz',
        'token-tracker-0.4.0.tgz',
        'token-tracker-linux-x64',
        'token-tracker-linux-arm64',
        'token-tracker-darwin-x64',
        'token-tracker-darwin-arm64',
      ]);
      if (!file || !allowed.has(file) || !directory || !path.isAbsolute(directory)) return notFound;
      const target = path.join(directory, file);
      const info = yield* Effect.result(fs.stat(target));
      if (Result.isFailure(info) || info.success.type !== 'File') return notFound;
      return yield* HttpServerResponse.file(target, {
        contentType: file.endsWith('.tgz') ? 'application/gzip' : 'application/octet-stream',
        headers: { 'content-disposition': `attachment; filename="${file}"`, 'x-content-type-options': 'nosniff' },
      }).pipe(Effect.match({ onFailure: () => notFound, onSuccess: (response) => response }));
    }),
  ).pipe(HttpRouter.provideRequest(Layer.mergeAll(BunServices.layer, BunHttpPlatform.layer)));
  const web = HttpRouter.toWebHandler(Layer.mergeAll(rpc, health, downloads), { disableLogger: true });
  return {
    ...web,
    handler: (request: Request) => {
      // Tailnet access is the dashboard's owner boundary in this personal mode.
      // Trust only a genuine same-origin browser POST; never return the pairing
      // secret or let an RPC payload supply its own browser authorization proof.
      const headers = new Headers(request.headers);
      headers.delete(dashboardProofHeader);
      const origin = headers.get('origin');
      if (origin && origin !== (expectedOrigin ?? new URL(request.url).origin)) {
        return Promise.resolve(new Response('Cross-origin requests are not allowed.', { status: 403 }));
      }
      if (origin) headers.set(dashboardProofHeader, browserProof);
      return web.handler(new Request(request, { headers }));
    },
  };
};

let server: ReturnType<typeof makeRpcWebHandler> | undefined;

export const handleRpcRequest = (request: Request) => {
  if (request.signal.aborted) return Promise.resolve(new Response(null, { status: 499 }));
  server ??= makeRpcWebHandler();
  return server.handler(request).then((response) => {
    response.headers.set('cache-control', 'no-store');
    return response;
  });
};

export const disposeRpcServer = async () => {
  const current = server;
  server = undefined;
  await current?.dispose();
};

if (import.meta.hot) import.meta.hot.dispose(() => disposeRpcServer());
else {
  // adapter-node emits this after SIGTERM/SIGINT has stopped accepting requests
  // and drained active connections. Disposing on the signal itself would retire
  // the shared database/runtime while those requests were still using it.
  process.once('sveltekit:shutdown', () => {
    void disposeRpcServer().catch((error: unknown) => console.error('Could not close token tracker resources:', error));
  });
}
