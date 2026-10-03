import { BunHttpPlatform, BunServices } from '@effect/platform-bun';
import { Context, Effect, FileSystem, Layer, Path, Result, Schedule } from 'effect';
import { randomBytes } from 'node:crypto';
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
import type { UsageEvent, UsageQuery } from '../../shared/domain';
import { collectUsage, buildDashboard, tokenTotal } from '../usage';
import { getLocalDevice } from './identity';
import { UsageStore, usageStoreLayer, type ServerOptions } from './store';

export class LocalUsage extends Context.Service<LocalUsage>()('token-tracker/LocalUsage', {
  make: Effect.gen(function* () {
    const device = yield* getLocalDevice();
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const collect = collectUsage({ deviceId: device.id }).pipe(
      Effect.provideService(FileSystem.FileSystem, filesystem),
      Effect.provideService(Path.Path, path),
    );
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
      const readUsage = Effect.fn('rpc.readUsage')(function* (query: UsageQuery) {
        const state = yield* loadPricing(directory);
        const [remote, current] = yield* Effect.all([store.getUsage(local.device.id), local.collect], {
          concurrency: 2,
        });
        const rawEvents = [...remote.events, ...current.events];
        const events = uniqueEvents(rawEvents, local.device.id, query).map((event) =>
          repriceEvent(event, state.policy),
        );
        const snapshotsByRecord = new Map(
          remote.pricingSnapshots.map((snapshot) => [`${snapshot.deviceId}:${snapshot.eventId}`, snapshot.updatedAt]),
        );
        const policySnapshot = `${state.info.updatedAt} · ${state.info.revision.slice(0, 12)}`;
        const snapshots = [
          ...new Set(
            events
              .filter((event) => event.costKnown)
              .map(
                (event) =>
                  (event.serviceTier !== undefined &&
                  (event.cacheWriteTokens === 0 || event.cacheWrite1hTokens !== undefined)
                    ? policySnapshot
                    : event.deviceId === local.device.id
                      ? current.pricingUpdatedAt
                      : snapshotsByRecord.get(`${event.deviceId}:${event.id}`)) || 'unknown',
              ),
          ),
        ].sort();
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
          rawEvents,
          query: effectiveQuery(query, state.policy),
          data: {
            events,
            sources: [...current.sources, ...remote.sources],
            warnings: [...current.warnings, ...remote.warnings, ...pricingWarnings],
            pricingUpdatedAt: snapshots.join(', ') || policySnapshot,
          },
        };
      });
      return {
        GetUsage: Effect.fn('rpc.GetUsage')(
          function* (query) {
            const result = yield* readUsage(query);
            return yield* Effect.try({
              try: () => {
                const dashboard = buildDashboard(result.data, result.query, new Date(), local.device.name);
                return {
                  ...dashboard,
                  pricing: {
                    ...dashboard.pricing,
                    method:
                      'Estimated API-equivalent cost from cached model prices and your saved aliases or custom rates. Subscription charges may differ; missing rates are excluded.',
                  },
                  filters: {
                    ...dashboard.filters,
                    ...(result.query.models ? { selectedModels: result.query.models } : {}),
                    devices: [...new Set(result.rawEvents.map((event) => event.deviceId ?? 'local'))].sort(),
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
            const groups = new Map<string, UsageEvent[]>();
            for (const event of result.data.events) {
              if (event.costKnown) continue;
              const raw = event.rawModel ?? event.model;
              const group = groups.get(raw) ?? [];
              group.push(event);
              groups.set(raw, group);
            }
            const now = new Date();
            const unresolved = [...groups]
              .flatMap(([model, events]) => {
                const tokens = buildDashboard({ ...result.data, events }, result.query, now).totals.tokens;
                if (!tokens) return [];
                const legacy = events.some(
                  (event) =>
                    event.serviceTier === undefined ||
                    (event.cacheWriteTokens > 0 && event.cacheWrite1hTokens === undefined),
                );
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
