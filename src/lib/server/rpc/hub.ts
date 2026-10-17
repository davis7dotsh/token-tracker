import { Cache, Clock, Context, Effect, Exit, Layer, Schedule, Schema } from 'effect';
import { createHash, randomBytes } from 'node:crypto';
import type { Headers as EffectHeaders } from 'effect/http/Headers';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { InvalidRequest, UsageFailure, UsageRpc, type PricingSettings } from '../../shared/rpc';
import type { PricingPolicy } from '../../shared/pricing';
import { UsageQuery, type CollectionError, type UsageEvent, type UsageResult } from '../../shared/domain';
import { tokenTotal } from '../usage/parsers';
import { repriceEvent, resolveDisplayModel } from '../usage/pricing';
import { makePricingRuntime, pricingRefreshDue, sqlPricingStorage, type PricingState } from '../usage/pricing-store';
import {
  buildDashboardSnapshot,
  eventMillis,
  isDashboardCurrent,
  matchesUsage,
  provider,
  usageTimeframe,
  type DashboardValidity,
} from '../usage/dashboard';
import { ServerConfiguration, UsageStore } from './store';

// The hub serves the dashboard RPC and sync uploads on any host. A Bun hub also
// collects its own machine's logs; the Cloudflare hub has no local device.
export class LocalUsage extends Context.Service<
  LocalUsage,
  {
    readonly device?: { readonly id: string; readonly name: string; readonly platform: string };
    readonly collect: Effect.Effect<UsageResult, CollectionError>;
    readonly revision?: (previous?: UsageResult) => Effect.Effect<string, CollectionError>;
  }
>()('token-tracker/LocalUsage') {}

export const noLocalUsage = Layer.succeed(LocalUsage, {
  collect: Effect.succeed({ events: [], sources: [], warnings: [], pricingUpdatedAt: '' }),
});

// Local logs are independent of ranges, remote uploads, and saved prices.
// Check their inexpensive source revision at most once per five seconds, and
// await one shared collection only when the sources have actually changed.
export const makeLocalUsageSnapshot = (
  collect: Effect.Effect<UsageResult, CollectionError>,
  revision?: (previous?: UsageResult) => Effect.Effect<string, CollectionError>,
) =>
  Effect.gen(function* () {
    let snapshot: { current: UsageResult; generation: number } | undefined;
    let observed: UsageResult | undefined;
    let fingerprint = '';
    let sourceRevision: string | undefined;
    let stable = true;
    const checks = yield* Cache.makeWith(
      () =>
        Effect.gen(function* () {
          const previous = observed;
          let before = revision ? yield* revision(previous) : undefined;
          stable = true;
          if (snapshot && revision && before === sourceRevision) return snapshot;
          let next = yield* collect;
          if (revision) {
            const after = yield* revision(next);
            if (before !== after) {
              // The first collection can discover repository dependencies, or
              // logs can change while being read. Stabilize once in this same
              // request rather than deferring updated records to a later poll.
              before = after;
              next = yield* collect;
              stable = before === (yield* revision(next));
            }
          }
          const digest = createHash('sha256').update(
            JSON.stringify([next.sources, next.warnings, next.pricingUpdatedAt, next.retractedIds]),
          );
          // Hash only changed collections, without allocating one enormous JSON
          // string or blocking requests for an entire history traversal.
          for (let offset = 0; offset < next.events.length; offset += 1_000) {
            for (const event of next.events.slice(offset, offset + 1_000))
              digest.update(JSON.stringify(event)).update('\n');
            yield* Effect.yieldNow;
          }
          const nextFingerprint = digest.digest('hex');
          if (!snapshot || nextFingerprint !== fingerprint) {
            snapshot = { current: next, generation: (snapshot?.generation ?? 0) + 1 };
            fingerprint = nextFingerprint;
          }
          // Dependency discovery is attached to the latest collected object.
          // Retain that observer separately when unchanged accounting reuses
          // the previous immutable event array and aggregate generation.
          observed = next;
          // Retain the pre-collection signal. A change during collection must be
          // checked again rather than labelling potentially older data as current.
          sourceRevision = before;
          return snapshot;
        }),
      { capacity: 1, timeToLive: (exit) => (Exit.isSuccess(exit) && stable ? '5 seconds' : 0) },
    );
    return Cache.get(checks, undefined);
  });

class SnapshotInput extends Context.Service<SnapshotInput, { current: UsageResult; state: PricingState }>()(
  'token-tracker/SnapshotInput',
) {}

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
  const devices = query.devices && new Set(query.devices);
  for (const incoming of events) {
    if (devices && !devices.has(incoming.deviceId ?? 'local')) continue;
    const key = `${incoming.harness}:${incoming.id}`;
    const existing = records.get(key);
    const preferredOwner =
      incoming.deviceId === localDeviceId ||
      (existing?.deviceId !== localDeviceId && (incoming.deviceId ?? '').localeCompare(existing?.deviceId ?? '') < 0);
    const incomingTokens = tokenTotal(incoming);
    const existingTokens = existing ? tokenTotal(existing) : -1;
    if (!existing || incomingTokens > existingTokens || (incomingTokens === existingTokens && preferredOwner))
      records.set(key, incoming);
  }
  return [...records.values()];
};

const dashboardProofHeader = 'x-token-tracker-pricing-access';
const pricingPolicyProofHeader = 'x-token-tracker-pricing-policy-access';
const normalizedQuery = (query: UsageQuery): UsageQuery => ({
  range: query.range ?? '30d',
  timezone: query.timezone ?? 'UTC',
  ...Object.fromEntries(
    (['harnesses', 'models', 'providers', 'projects', 'excludedProjects', 'devices'] as const).flatMap((field) =>
      query[field] === undefined ? [] : [[field, [...new Set(query[field])].sort()]],
    ),
  ),
});
const retainResult = <A>(cache: Map<string, A>, key: string, value: A) => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 8) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
};
// Same wire protocol and URL for existing uploads, but a separate group keeps
// anonymous requests from invoking dashboard reads, including batched reads,
// and device administration.
const CollectorRpc = UsageRpc.omit(
  'GetUsage',
  'GetDevices',
  'GetPricing',
  'GetAdminAccess',
  'RenameDevice',
  'RevokeDevice',
  'RestoreDevice',
);

export const rpcHandlersLayer = (browserProof: string, options: HubOptions) =>
  UsageRpc.toLayer(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      const local = yield* LocalUsage;
      const pricing = yield* HubPricing;
      const localSnapshot = yield* makeLocalUsageSnapshot(local.collect, local.revision);
      const localDeviceId = local.device?.id ?? '';
      if (options.autoRefreshPricing) {
        yield* pricing.load.pipe(
          Effect.flatMap((state) => (pricingRefreshDue(state.info) ? pricing.refresh : Effect.succeed(state))),
          Effect.catch(() => Effect.void),
          Effect.repeat(Schedule.spaced('1 hour')),
          Effect.forkScoped,
        );
      }
      const authorize = (secret: string, headers: EffectHeaders, action?: string) =>
        options.trustBrowser && headers[dashboardProofHeader] === browserProof
          ? Effect.void
          : store.authorizeAdmin(secret, action);
      const isLocalDevice = (deviceId: string) =>
        deviceId === 'local' || (localDeviceId !== '' && deviceId === localDeviceId);
      const changeDevice = Effect.fn('rpc.changeDevice')(function* (
        deviceId: string,
        adminSecret: string,
        headers: EffectHeaders,
      ) {
        yield* authorize(adminSecret, headers, 'Device changes');
        if (isLocalDevice(deviceId))
          return yield* new InvalidRequest({
            message: 'This hub’s own machine cannot be renamed, revoked, or restored.',
          });
      });
      const effectiveQuery = (query: UsageQuery, policy: PricingPolicy): UsageQuery => ({
        ...query,
        models: query.models && [...new Set(query.models.map((model) => resolveDisplayModel(model, policy)))],
      });
      const decodeReadKey = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({
            query: UsageQuery,
            revision: Schema.Number,
            metadataRevision: Schema.Number,
            localGeneration: Schema.Number,
            start: Schema.optionalKey(Schema.String),
            end: Schema.optionalKey(Schema.String),
            pricingRevision: Schema.optionalKey(Schema.String),
          }),
        ),
      );
      const readRawSnapshot = Effect.fn('rpc.readRawSnapshot')(function* (key: string) {
        const { query, start, end } = decodeReadKey(key);
        const { current } = yield* SnapshotInput;
        const previousMillis = start ? Date.parse(start) : -Infinity;
        const endMillis = end ? Date.parse(end) : Infinity;
        const localCandidates = start
          ? current.events
              .filter((event) => {
                const millis = eventMillis(event);
                return millis >= previousMillis && millis < endMillis;
              })
              .map((event) => event.id)
          : [];
        const [remote, dimensions] = yield* Effect.all(
          [
            store.getUsage(localDeviceId, {
              ...(start ? { start } : {}),
              ...(end ? { end } : {}),
              devices: query.devices,
              candidateIds: localCandidates,
            }),
            store.getDimensions(localDeviceId),
          ],
          {
            concurrency: 2,
          },
        );
        // Local histories repeat the same dimensions for every request. Keep
        // only actual choices, and share them across pricing-only recalculation.
        const seen = new Map<string, Map<string, Map<string, Set<string>>>>();
        const choices: (typeof dimensions)[number][] = [];
        const addDimension = (deviceId: string, harness: UsageEvent['harness'], model: string, project: string) => {
          let harnesses = seen.get(deviceId);
          if (!harnesses) {
            harnesses = new Map();
            seen.set(deviceId, harnesses);
          }
          let models = harnesses.get(harness);
          if (!models) {
            models = new Map();
            harnesses.set(harness, models);
          }
          let projects = models.get(model);
          if (!projects) {
            projects = new Set();
            models.set(model, projects);
          }
          if (projects.has(project)) return;
          projects.add(project);
          choices.push({ deviceId, harness, model, project });
        };
        for (const dimension of dimensions)
          addDimension(dimension.deviceId, dimension.harness, dimension.model, dimension.project);
        for (const event of current.events)
          addDimension(
            event.deviceId ?? 'local',
            event.harness,
            event.rawModel ?? event.model,
            event.repository ?? event.project,
          );
        return {
          remote,
          current,
          dimensions: choices,
          unique: uniqueEvents([...remote.events, ...current.events], localDeviceId, query),
        };
      });
      // A pricing edit invalidates calculated prices, not the underlying usage.
      // Reuse validated records so a save never rereads unchanged log history.
      const rawSnapshots = yield* Cache.makeWith(readRawSnapshot, {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
        requireServicesAt: 'lookup',
      });
      const readSnapshot = Effect.fn('rpc.readSnapshot')(function* (key: string) {
        const { pricingRevision: _, ...rawKey } = decodeReadKey(key);
        const { state } = yield* SnapshotInput;
        const { remote, current, dimensions, unique } = yield* Cache.get(rawSnapshots, JSON.stringify(rawKey));
        const events: UsageEvent[] = [];
        const unknownLocalModels = new Set<string>();
        for (let offset = 0; offset < unique.length; offset += 1_000) {
          const end = Math.min(offset + 1_000, unique.length);
          for (let index = offset; index < end; index++) {
            const event = repriceEvent(unique[index], state.policy);
            events.push(event);
            if ((event.deviceId ?? '') === localDeviceId && !event.costKnown)
              unknownLocalModels.add(event.rawModel ?? event.model);
          }
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
          dimensions,
          data: {
            events,
            sources: [...current.sources, ...remote.sources],
            warnings: [
              ...current.warnings.filter((warning) => !warning.startsWith('No reliable API price for: ')),
              ...(unknownLocalModels.size
                ? [
                    `No reliable API price for: ${[...unknownLocalModels].sort().join(', ')}. These tokens are included, but their costs are unavailable.`,
                  ]
                : []),
              ...remote.warnings,
              ...pricingWarnings,
            ],
            pricingUpdatedAt: snapshots.join(', ') || policySnapshot,
          },
        };
      });
      // Full event histories are the expensive layer to retain. Final response
      // caches below keep eight revisitable queries without holding those arrays.
      const snapshots = yield* Cache.makeWith(readSnapshot, {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
        requireServicesAt: 'lookup',
      });
      const dashboards = new Map<string, ReturnType<typeof buildDashboardSnapshot>>();
      const pricingResults = new Map<
        string,
        { unresolved: PricingSettings['unresolved']; validity: DashboardValidity }
      >();
      let snapshotEpoch = '';
      let snapshotPricing = '';
      const readQuery = Effect.fn('rpc.readQuery')(function* (query: UsageQuery) {
        const { current, generation } = yield* localSnapshot;
        const state = yield* pricing.load;
        const revision = store.getRevision();
        const metadataRevision = store.getMetadataRevision();
        const epoch = `${revision}:${metadataRevision}:${generation}`;
        if (epoch !== snapshotEpoch) {
          snapshotEpoch = epoch;
          yield* Cache.invalidateAll(rawSnapshots);
          yield* Cache.invalidateAll(snapshots);
          dashboards.clear();
          pricingResults.clear();
        } else if (snapshotPricing !== state.policy.revision) {
          yield* Cache.invalidateAll(snapshots);
          dashboards.clear();
          pricingResults.clear();
        }
        snapshotPricing = state.policy.revision;
        const now = new Date(yield* Clock.currentTimeMillis);
        const timeframe = usageTimeframe(query, now);
        const effective = effectiveQuery(query, state.policy);
        const normalized = normalizedQuery(effective);
        const readKey = {
          query: {
            range: normalized.range,
            timezone: normalized.timezone,
            ...(normalized.devices ? { devices: normalized.devices } : {}),
          },
          revision,
          metadataRevision,
          localGeneration: generation,
          ...(timeframe.range !== 'all'
            ? {
                start: timeframe.previousStart.startOfDay().toInstant().toString({ fractionalSecondDigits: 3 }),
                end: timeframe.end.toInstant().toString({ fractionalSecondDigits: 3 }),
              }
            : {}),
          pricingRevision: state.policy.revision,
        };
        return {
          current,
          state,
          readKey: JSON.stringify(readKey),
          resultKey: JSON.stringify({ ...readKey, query: normalized }),
          query: effective,
          normalized,
          now,
          timeframe,
        };
      });
      return {
        GetUsage: Effect.fn('rpc.GetUsage')(
          function* (query) {
            const input = yield* readQuery(query);
            let cached = dashboards.get(input.resultKey);
            if (!cached || !isDashboardCurrent(cached, input.timeframe, input.now)) {
              const result = yield* Cache.get(snapshots, input.readKey).pipe(
                Effect.provideService(SnapshotInput, { current: input.current, state: input.state }),
              );
              // A concurrent reader can finish the same small response while
              // this request waits for shared event preparation.
              cached = dashboards.get(input.resultKey);
              if (!cached || !isDashboardCurrent(cached, input.timeframe, input.now))
                cached = yield* Effect.try({
                  try: () => {
                    const snapshot = buildDashboardSnapshot(
                      result.data,
                      input.normalized,
                      input.now,
                      local.device?.name ?? 'All devices',
                      result.state.policy,
                    );
                    const available = result.dimensions.filter(
                      (dimension) => !input.query.devices || input.query.devices.includes(dimension.deviceId),
                    );
                    const models = [
                      ...new Set(
                        available.map((dimension) => resolveDisplayModel(dimension.model, result.state.policy)),
                      ),
                    ].sort();
                    return {
                      ...snapshot,
                      response: {
                        ...snapshot.response,
                        filters: {
                          harnesses: [...new Set(available.map((dimension) => dimension.harness))].sort(),
                          models,
                          providers: [...new Set(models.map(provider))].sort(),
                          projects: [...new Set(available.map((dimension) => dimension.project))].sort(),
                          modelProviders: models.map((model) => ({ model, provider: provider(model) })),
                          devices: [...new Set(result.dimensions.map((dimension) => dimension.deviceId))].sort(),
                        },
                      },
                    };
                  },
                  catch: () => new UsageFailure({ message: 'The selected usage timeframe or timezone is invalid.' }),
                });
            }
            retainResult(dashboards, input.resultKey, cached);
            return {
              ...cached.response,
              generatedAt: input.now.toISOString(),
              filters: {
                ...cached.response.filters,
                ...(input.query.models ? { selectedModels: input.query.models } : {}),
              },
            };
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetPricing: Effect.fn('rpc.GetPricing')(
          function* (query) {
            const input = yield* readQuery(query);
            let cached = pricingResults.get(input.resultKey);
            if (!cached || !isDashboardCurrent(cached.validity, input.timeframe, input.now)) {
              const result = yield* Cache.get(snapshots, input.readKey).pipe(
                Effect.provideService(SnapshotInput, { current: input.current, state: input.state }),
              );
              cached = pricingResults.get(input.resultKey);
              if (!cached || !isDashboardCurrent(cached.validity, input.timeframe, input.now)) {
                const groups = new Map<string, { tokens: number; legacy: boolean }>();
                const timeframe = input.timeframe;
                const start = timeframe.start.epochMilliseconds;
                const now = input.now.getTime();
                const end = Math.min(timeframe.end.epochMilliseconds, now + 1);
                const validity: DashboardValidity = {
                  todayMillis: timeframe.today.epochMilliseconds,
                  calendarStart: timeframe.range === 'all' ? undefined : timeframe.start.startOfDay().epochMilliseconds,
                  nowBefore: -Infinity,
                  nowAfter: Infinity,
                  startBefore: -Infinity,
                  startAfter: Infinity,
                  previousBefore: -Infinity,
                  previousAfter: Infinity,
                };
                for (const event of result.data.events) {
                  if (event.costKnown || !matchesUsage(input.normalized, event)) continue;
                  const millis = eventMillis(event);
                  if (!Number.isFinite(millis)) continue;
                  if (millis <= now) validity.nowBefore = Math.max(validity.nowBefore, millis);
                  else validity.nowAfter = Math.min(validity.nowAfter, millis);
                  if (timeframe.range !== 'all') {
                    if (millis < start) validity.startBefore = Math.max(validity.startBefore, millis);
                    else validity.startAfter = Math.min(validity.startAfter, millis);
                  }
                  if ((timeframe.range !== 'all' && millis < start) || millis >= end) continue;
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
                cached = { unresolved, validity };
              }
            }
            retainResult(pricingResults, input.resultKey, cached);
            return { info: input.state.info, unresolved: cached.unresolved, secretRequired: !options.trustBrowser };
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetPricingPolicy: Effect.fn('rpc.GetPricingPolicy')(function* (
          { revision, deviceId, token, pairingSecret },
          { headers },
        ) {
          // Require credentials unless the handler granted dashboard access.
          // RPC messages can override HTTP headers, so removing a proof must
          // fail closed rather than bypass this check.
          if (headers[pricingPolicyProofHeader] !== browserProof) {
            if (pairingSecret !== undefined) yield* store.authorizeAdmin(pairingSecret);
            else yield* store.authorizeDevice(deviceId ?? '', token ?? '');
          }
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
          return [
            { ...device, lastSeen: new Date().toISOString(), eventCount: 0, revokedAt: null, needsReconnect: false },
            ...devices,
          ];
        }),
        GetAdminAccess: () =>
          Effect.succeed({ secretRequired: !options.trustBrowser, localDeviceId: local.device?.id ?? null }),
        RenameDevice: Effect.fn('rpc.RenameDevice')(function* ({ deviceId, name, adminSecret }, { headers }) {
          yield* changeDevice(deviceId, adminSecret, headers);
          return yield* store.renameDevice(deviceId, name);
        }),
        RevokeDevice: Effect.fn('rpc.RevokeDevice')(function* ({ deviceId, adminSecret }, { headers }) {
          yield* changeDevice(deviceId, adminSecret, headers);
          return yield* store.revokeDevice(deviceId);
        }),
        RestoreDevice: Effect.fn('rpc.RestoreDevice')(function* ({ deviceId, adminSecret }, { headers }) {
          yield* changeDevice(deviceId, adminSecret, headers);
          return yield* store.restoreDevice(deviceId);
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
  const handlers = rpcHandlersLayer(browserProof, options).pipe(Layer.provide(services));
  const rpc = RpcServer.layerHttp({ group: UsageRpc, path: '/rpc', protocol: 'http' }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerNdjson),
  );
  const collectorRpc = RpcServer.layerHttp({ group: CollectorRpc, path: '/collector', protocol: 'http' }).pipe(
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
  const web = HttpRouter.toWebHandler(Layer.mergeAll(rpc, collectorRpc, health, routes), { disableLogger: true });
  return {
    ...web,
    handler: (request: Request, collectorOnly = false) => {
      // Trust only a genuine same-origin browser POST; never return the pairing
      // secret or let an RPC payload supply its own browser authorization proof.
      const headers = new Headers(request.headers);
      headers.delete(dashboardProofHeader);
      headers.delete(pricingPolicyProofHeader);
      const url = new URL(request.url);
      if (collectorOnly && request.method === 'POST') url.pathname = '/collector';
      if (url.pathname === '/rpc') headers.set(pricingPolicyProofHeader, browserProof);
      const origin = headers.get('origin');
      if (origin && origin !== (options.expectedOrigin ?? new URL(request.url).origin)) {
        return Promise.resolve(new Response('Cross-origin requests are not allowed.', { status: 403 }));
      }
      if (origin && url.pathname === '/rpc') headers.set(dashboardProofHeader, browserProof);
      return web.handler(
        new Request(url, { method: request.method, headers, body: request.body, signal: request.signal }),
      );
    },
  };
};
