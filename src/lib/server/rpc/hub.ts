import { Cache, Clock, Context, Effect, Exit, Layer, Option, Schedule, Schema, type Scope } from 'effect';
import { createHash, randomBytes } from 'node:crypto';
import type { Headers as EffectHeaders } from 'effect/http/Headers';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { InvalidRequest, UsageFailure, UsageRpc, type PricingSettings } from '../../shared/rpc';
import type { PricingPolicy } from '../../shared/pricing';
import {
  UsageQuery,
  type DashboardBucketBreakdown,
  type DashboardResponse,
  type CollectionError,
  type UsageEvent,
  type UsageFilters,
  type UsageResult,
  type Session,
  type SessionSort,
} from '../../shared/domain';
import { sessionPageSize } from '../../shared/dashboard-page';
import {
  projectBucketBreakdown,
  projectProjectLabels,
  projectViewBase,
  projectViewSession,
  type ProjectedViewBase,
} from '../../shared/dashboard-view';
import { projectLabels } from '../../shared/project-label';
import { isDefaultSessionSort, sortSessions } from '../../shared/session-sort';
import { tokenTotal } from '../usage/parsers';
import {
  describePricingGaps,
  PricingGap,
  pricingGaps,
  repriceEvent,
  resolveDisplayModel,
  retainsRecordedCost,
} from '../usage/pricing';
import { makePricingRuntime, pricingRefreshDue, sqlPricingStorage, type PricingState } from '../usage/pricing-store';
import {
  aggregateDashboard,
  pricingMethod,
  eventMillis,
  isDashboardCurrent,
  usageMatchers,
  provider,
  usageTimeframe,
  type DashboardValidity,
} from '../usage/dashboard';
import { makeViewWarmer, type ViewHints } from './view-warmer';
import { ServerConfiguration, UsageStore } from './store';
import { collectorVersion, releaseVersion } from '../../shared/version';

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

// A self-hosted hub can also pull usage on a timer (the trace source). It
// writes through the store like uploads do; `refreshed` re-warms the last view.
export class UsageFeed extends Context.Service<
  UsageFeed,
  {
    readonly run: (refreshed: Effect.Effect<void>) => Effect.Effect<void, never, UsageStore | HubPricing | Scope.Scope>;
  }
>()('token-tracker/UsageFeed') {}

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
  readonly viewHints?: ViewHints;
};

// Store every device's copy for its own view, but count one native request when
// those logs have been copied between machines. Filtering precedes deduplication
// so a device remains independently inspectable.
const uniqueEvents = (
  remote: readonly UsageEvent[],
  local: readonly UsageEvent[],
  localDeviceId: string,
  query: UsageQuery,
) => {
  const positions = new Map<UsageEvent['harness'], Map<string, number>>();
  const records: UsageEvent[] = [];
  const devices = query.devices && new Set(query.devices);
  for (const events of [remote, local])
    for (const incoming of events) {
      if (devices && !devices.has(incoming.deviceId ?? 'local')) continue;
      let ids = positions.get(incoming.harness);
      if (!ids) {
        ids = new Map();
        positions.set(incoming.harness, ids);
      }
      const index = ids.get(incoming.id);
      if (index === undefined) {
        ids.set(incoming.id, records.length);
        records.push(incoming);
        continue;
      }
      const existing = records[index];
      const incomingTokens = tokenTotal(incoming);
      const existingTokens = tokenTotal(existing);
      if (
        incomingTokens > existingTokens ||
        (incomingTokens === existingTokens &&
          (incoming.deviceId === localDeviceId ||
            (existing.deviceId !== localDeviceId &&
              (incoming.deviceId ?? '').localeCompare(existing.deviceId ?? '') < 0)))
      )
        records[index] = incoming;
    }
  return records;
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
  'GetSessionExport',
  'GetUsagePage',
  'GetUsagePageUpdate',
  'GetUsageView',
  'GetUsageViewUpdate',
  'GetUsageBucket',
  'GetUsageFilters',
  'GetUsageInfo',
  'GetHubInfo',
  'GetDevices',
  'GetPricing',
  'GetPricingCatalog',
  'GetUnresolvedPricing',
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
            localGeneration: Schema.Number,
            start: Schema.optionalKey(Schema.String),
            end: Schema.optionalKey(Schema.String),
            pricingRevision: Schema.optionalKey(Schema.String),
          }),
        ),
      );
      type DimensionRow = { deviceId: string; harness: UsageEvent['harness']; model: string; project: string };
      let cachedDimensions: { epoch: string; rows: readonly DimensionRow[] } | undefined;
      const collectDimensions = (
        remoteDimensions: readonly DimensionRow[],
        localEvents: readonly UsageEvent[],
      ): readonly DimensionRow[] => {
        const seen = new Map<string, Map<string, Map<string, Set<string>>>>();
        const choices: DimensionRow[] = [];
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
        for (const dimension of remoteDimensions)
          addDimension(dimension.deviceId, dimension.harness, dimension.model, dimension.project);
        for (const event of localEvents)
          addDimension(
            event.deviceId ?? 'local',
            event.harness,
            event.rawModel ?? event.model,
            event.repository ?? event.project,
          );
        return choices;
      };
      const readRawSnapshot = Effect.fn('rpc.readRawSnapshot')(function* (key: string) {
        const { query, start, end, revision, localGeneration } = decodeReadKey(key);
        const { current } = yield* SnapshotInput;
        const epoch = `${revision}:${localGeneration}`;
        const previousMillis = start ? Date.parse(start) : -Infinity;
        const endMillis = end ? Date.parse(end) : Infinity;
        const localCandidates: string[] = [];
        if (start)
          for (const event of current.events) {
            if (query.devices && !query.devices.includes(event.deviceId ?? 'local')) continue;
            const millis = eventMillis(event);
            if (millis >= previousMillis && millis < endMillis) localCandidates.push(event.id);
          }
        const [remote, dimensions] = yield* Effect.all(
          [
            store.getUsage(localDeviceId, {
              ...(start ? { start } : {}),
              ...(end ? { end } : {}),
              devices: query.devices,
              candidateIds: localCandidates,
            }),
            cachedDimensions?.epoch === epoch
              ? Effect.succeed(cachedDimensions.rows)
              : Effect.map(store.getDimensions(localDeviceId), (rows) => {
                  const collected = collectDimensions(rows, current.events);
                  cachedDimensions = { epoch, rows: collected };
                  return collected;
                }),
          ],
          {
            concurrency: 2,
          },
        );
        return {
          remote,
          current,
          dimensions,
          unique: uniqueEvents(remote.events, current.events, localDeviceId, query),
        };
      });
      // A pricing edit invalidates calculated prices, not the underlying usage.
      // Reuse validated records so a save never rereads unchanged log history.
      const rawSnapshots = yield* Cache.makeWith(readRawSnapshot, {
        capacity: 2,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
        requireServicesAt: 'lookup',
      });
      // Repricing can change both the value and identity of a stored event.
      // A stable priced record lets the analytics layer reuse an unchanged
      // block after a neighboring day is updated, without pinning its inputs.
      const prices = new WeakMap<PricingPolicy, WeakMap<UsageEvent, UsageEvent>>();
      const readSnapshot = Effect.fn('rpc.readSnapshot')(function* (key: string) {
        const { pricingRevision: _, ...rawKey } = decodeReadKey(key);
        const { state } = yield* SnapshotInput;
        const { remote, current, dimensions, unique } = yield* Cache.get(rawSnapshots, JSON.stringify(rawKey));
        let priced = prices.get(state.policy);
        if (!priced) {
          priced = new WeakMap();
          prices.set(state.policy, priced);
        }
        const events: UsageEvent[] = [];
        const unknownLocalModels = new Set<string>();
        // Records without pricing metadata keep a reported cost; saved rules
        // can still estimate them when none was reported, and free rules always apply.
        const policySnapshot = `${state.info.updatedAt} · ${state.info.revision.slice(0, 12)}`;
        const legacy = new Map<string, Set<string>>();
        const snapshotSet = new Set<string>();
        const unpriced: UsageEvent[] = [];
        for (let offset = 0; offset < unique.length; offset += 1_000) {
          const end = Math.min(offset + 1_000, unique.length);
          for (let index = offset; index < end; index++) {
            const source = unique[index];
            let event = priced.get(source);
            if (!event) {
              event = repriceEvent(source, state.policy);
              priced.set(source, event);
            }
            events.push(event);
            if (!event.costKnown) {
              unpriced.push(event);
              if ((event.deviceId ?? '') === localDeviceId) unknownLocalModels.add(event.rawModel ?? event.model);
            } else if (!retainsRecordedCost(source, state.policy)) snapshotSet.add(policySnapshot);
            else if (event.deviceId === localDeviceId) snapshotSet.add(current.pricingUpdatedAt || 'unknown');
            else {
              const device = event.deviceId ?? '';
              let ids = legacy.get(device);
              if (!ids) {
                ids = new Set();
                legacy.set(device, ids);
              }
              ids.add(event.id);
            }
          }
          yield* Effect.yieldNow;
        }
        if (legacy.size) {
          for (const snapshot of remote.pricingSnapshots) {
            if (legacy.get(snapshot.deviceId)?.delete(snapshot.eventId))
              snapshotSet.add(snapshot.updatedAt || 'unknown');
          }
          if ([...legacy.values()].some((ids) => ids.size)) snapshotSet.add('unknown');
        }
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
        const devices = rawKey.query.devices && new Set(rawKey.query.devices);
        const available = devices ? dimensions.filter((row) => devices.has(row.deviceId)) : dimensions;
        const models = [...new Set(available.map((row) => resolveDisplayModel(row.model, state.policy)))].sort();
        return {
          state,
          filters: {
            harnesses: [...new Set(available.map((row) => row.harness))].sort(),
            models,
            providers: [...new Set(models.map(provider))].sort(),
            projects: [...new Set(available.map((row) => row.project))].sort(),
            modelProviders: models.map((model) => ({ model, provider: provider(model) })),
            devices: [...new Set(dimensions.map((row) => row.deviceId))].sort(),
          },
          unpriced,
          data: {
            events,
            sources: current.sources,
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
      const dashboards = new Map<string, ReturnType<typeof aggregateDashboard>>();
      const pricingResults = new Map<
        string,
        { unresolved: PricingSettings['unresolved']; validity: DashboardValidity }
      >();
      const filterCatalogs = new Map<string, { filters: UsageFilters; projectLabels: ReadonlyMap<string, string> }>();
      let snapshotEpoch = '';
      let snapshotPricing = '';
      const syncEpoch = Effect.fnUntraced(function* () {
        const { current, generation } = yield* localSnapshot;
        const state = yield* pricing.load;
        const revision = store.getRevision();
        const epoch = `${revision}:${generation}`;
        if (epoch !== snapshotEpoch) {
          snapshotEpoch = epoch;
          cachedDimensions = undefined;
          filterCatalogs.clear();
          yield* Cache.invalidateAll(rawSnapshots);
          yield* Cache.invalidateAll(snapshots);
          dashboards.clear();
          pricingResults.clear();
        } else if (snapshotPricing !== state.policy.revision) {
          filterCatalogs.clear();
          yield* Cache.invalidateAll(snapshots);
          dashboards.clear();
          pricingResults.clear();
        }
        snapshotPricing = state.policy.revision;
        return { current, generation, state, revision, epoch };
      });
      const readFilterCatalog = Effect.fn('rpc.readFilterCatalog')(function* (devices?: readonly string[]) {
        const { current, state, epoch } = yield* syncEpoch();
        const normalizedDevices = devices === undefined ? undefined : [...new Set(devices)].sort();
        const key = normalizedDevices ? JSON.stringify(normalizedDevices) : '';
        const hit = filterCatalogs.get(key);
        if (hit) return hit;
        let rows = cachedDimensions?.epoch === epoch ? cachedDimensions.rows : undefined;
        if (!rows) {
          const remoteDimensions = yield* store.getDimensions(localDeviceId);
          rows = collectDimensions(remoteDimensions, current.events);
          cachedDimensions = { epoch, rows };
        }
        const selectedDevices = normalizedDevices && new Set(normalizedDevices);
        const available = selectedDevices ? rows.filter((row) => selectedDevices.has(row.deviceId)) : rows;
        const harnesses = [...new Set(available.map((row) => row.harness))].sort();
        const models = [...new Set(available.map((row) => resolveDisplayModel(row.model, state.policy)))].sort();
        const providers = [...new Set(models.map(provider))].sort();
        const projects = [...new Set(available.map((row) => row.project))].sort();
        const allDevices = [...new Set(rows.map((row) => row.deviceId))].sort();
        const filterRevision = createHash('sha256')
          .update(JSON.stringify([harnesses, models, providers, projects, allDevices]))
          .digest('hex')
          .slice(0, 16);
        const catalog = {
          filters: { filterRevision, harnesses, models, providers, projects, devices: allDevices },
          projectLabels: projectLabels(projects),
        };
        retainResult(filterCatalogs, key, catalog);
        return catalog;
      });
      const readQuery = Effect.fn('rpc.readQuery')(function* (query: UsageQuery) {
        const { current, generation, state, revision } = yield* syncEpoch();
        const now = new Date(yield* Clock.currentTimeMillis);
        const timeframe = usageTimeframe(query, now);
        const effective = effectiveQuery(query, state.policy);
        const normalized = normalizedQuery(effective);
        const readKey = {
          query: normalized.devices ? { devices: normalized.devices } : {},
          revision,
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
      // Tokens are opaque and instance-local. A recomputation (including a clock
      // boundary), another filter, or refreshed source metadata requires a full page.
      const pageVersions = new WeakMap<
        DashboardResponse,
        {
          sources: DashboardResponse['sources'];
          selection: string | undefined;
          revision: string;
        }
      >();
      // Dashboard views omit sources, so remote device heartbeats do not bust
      // view delta revisions when accounting has not changed.
      const viewVersions = new WeakMap<DashboardResponse, { selection: string | undefined; revision: string }>();
      const projectedViews = new WeakMap<DashboardResponse, ProjectedViewBase>();
      const projectedBuckets = new WeakMap<DashboardResponse, Map<string, DashboardBucketBreakdown | null>>();
      const getAggregate = Effect.fn('rpc.getAggregate')(
        function* (query: UsageQuery) {
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
                try: () =>
                  aggregateDashboard(
                    result.data,
                    input.normalized,
                    input.now,
                    local.device?.name ?? 'All devices',
                    result.state.policy,
                    input.timeframe,
                    result.filters,
                  ),
                catch: () => new UsageFailure({ message: 'The selected usage timeframe or timezone is invalid.' }),
              });
          }
          retainResult(dashboards, input.resultKey, cached);
          return { input, cached };
        },
        Effect.mapError((error) =>
          error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
        ),
      );
      const getUsage = Effect.fn('rpc.GetUsage')(
        function* (query: UsageQuery) {
          const { input, cached } = yield* getAggregate(query);
          const sources = yield* store.getSources(localDeviceId);
          const selection = JSON.stringify(input.query.models);
          let version = pageVersions.get(cached.response);
          if (!version || version.sources !== sources || version.selection !== selection) {
            version = { sources, selection, revision: randomBytes(16).toString('hex') };
            pageVersions.set(cached.response, version);
          }
          return {
            ...cached.response,
            viewRevision: version.revision,
            generatedAt: input.now.toISOString(),
            sources: [...input.current.sources, ...sources],
            filters: {
              ...cached.response.filters,
              ...(input.query.models ? { selectedModels: input.query.models } : {}),
            },
          };
        },
        Effect.mapError((error) =>
          error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
        ),
      );
      const getPricing = Effect.fn('rpc.GetPricing')(
        function* (query: UsageQuery) {
          const input = yield* readQuery(query);
          let cached = pricingResults.get(input.resultKey);
          if (!cached || !isDashboardCurrent(cached.validity, input.timeframe, input.now)) {
            const policy = input.state.policy;
            const candidates =
              input.timeframe.range === 'all' && query.devices === undefined
                ? yield* store.getPricingCandidates(localDeviceId, input.current.events, policy)
                : undefined;
            const unpriced = candidates
              ? uniqueEvents(candidates.remote, candidates.local, localDeviceId, query)
                  .map((event) => repriceEvent(event, policy))
                  .filter((event) => !event.costKnown)
              : (yield* Cache.get(snapshots, input.readKey).pipe(
                  Effect.provideService(SnapshotInput, { current: input.current, state: input.state }),
                )).unpriced;
            cached = pricingResults.get(input.resultKey);
            if (!cached || !isDashboardCurrent(cached.validity, input.timeframe, input.now)) {
              const groups = new Map<string, { tokens: number; gaps: number; tiers: Set<string> }>();
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
              const match = usageMatchers(input.normalized);
              for (const event of unpriced) {
                if (!match.dimensions(event) || !match.projects(event)) continue;
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
                const group = groups.get(raw) ?? { tokens: 0, gaps: 0, tiers: new Set<string>() };
                const gaps = pricingGaps(event, policy);
                group.tokens += tokenTotal(event);
                group.gaps |= gaps;
                if (gaps & PricingGap.tier) group.tiers.add(event.serviceTier ?? '');
                groups.set(raw, group);
              }
              const unresolved = [...groups]
                .flatMap(([model, { tokens, gaps, tiers }]) =>
                  tokens ? [{ model, tokens, reason: describePricingGaps(model, gaps, tiers, policy) }] : [],
                )
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
      );
      const warmer = yield* makeViewWarmer(options.viewHints, getAggregate, store.getRevision);
      const feed = yield* Effect.serviceOption(UsageFeed);
      if (Option.isSome(feed)) yield* feed.value.run(warmer.refreshed()).pipe(Effect.forkScoped);
      // The dashboard's device list: registered devices plus this hub's own
      // machine, which collects directly and may never have registered.
      const listDevices = Effect.fn('rpc.listDevices')(function* () {
        const devices = yield* store.getDevices();
        const device = local.device;
        if (!device || devices.some((item) => item.id === device.id)) return devices;
        return [
          {
            ...device,
            collectorVersion,
            lastSeen: new Date().toISOString(),
            eventCount: 0,
            revokedAt: null,
            needsReconnect: false,
          },
          ...devices,
        ];
      });
      // One sorted copy per dashboard snapshot and order; paging reuses it.
      // Device order also depends on names, which renames change without new usage.
      const sorted = new WeakMap<readonly Session[], Map<string, readonly Session[]>>();
      const sortedSessions = Effect.fnUntraced(function* (
        sessions: readonly Session[],
        machine: string,
        sort: SessionSort | undefined,
      ) {
        if (!sort || isDefaultSessionSort(sort)) return sessions;
        const names = new Map(
          sort.by === 'device'
            ? (yield* listDevices().pipe(Effect.orElseSucceed(() => []))).map((d) => [d.id, d.name] as const)
            : [],
        );
        const key = `${sort.by}:${sort.order}:${JSON.stringify([...names])}`;
        let bySort = sorted.get(sessions);
        if (!bySort) sorted.set(sessions, (bySort = new Map()));
        const cached = bySort.get(key);
        if (cached) return cached;
        const result = sortSessions(sessions, sort, (id) => names.get(id) ?? (id === 'local' ? machine : id));
        bySort.set(key, result);
        return result;
      });
      const getPage = Effect.fn('rpc.GetUsagePage')(function* ({
        query,
        page,
        sort,
      }: {
        query: UsageQuery;
        page: number;
        sort?: SessionSort;
      }) {
        const { projectInsights: _insights, ...dashboard } = yield* getUsage(query);
        yield* warmer.visited(query);
        const sessions = yield* sortedSessions(dashboard.sessions, dashboard.machine, sort);
        const sessionCount = sessions.length;
        const lastPage = Math.max(1, Math.ceil(sessionCount / sessionPageSize));
        const sessionOffset = (Math.min(page, lastPage) - 1) * sessionPageSize;
        return {
          ...dashboard,
          sessions: sessions.slice(sessionOffset, sessionOffset + sessionPageSize),
          sessionCount,
          sessionOffset,
        };
      });
      const getViewRevision = (response: DashboardResponse, selection: string | undefined) => {
        let version = viewVersions.get(response);
        if (!version || version.selection !== selection) {
          version = { selection, revision: randomBytes(16).toString('hex') };
          viewVersions.set(response, version);
        }
        return version.revision;
      };
      const getViewBase = (response: DashboardResponse) => {
        let base = projectedViews.get(response);
        if (!base) {
          base = projectViewBase(response);
          projectedViews.set(response, base);
        }
        return base;
      };
      const getBucketForResponse = (
        response: DashboardResponse,
        base: ProjectedViewBase,
        bucketKey: string,
        viewRevision: string,
        resolvedLabels: ReadonlyMap<string, string>,
      ) => {
        let byBucket = projectedBuckets.get(response);
        if (!byBucket) projectedBuckets.set(response, (byBucket = new Map()));
        const cacheKey = `${viewRevision}:${bucketKey}`;
        const existing = byBucket.get(cacheKey);
        if (existing) return existing;
        const result = projectBucketBreakdown(base.groupedBuckets, bucketKey, viewRevision, resolvedLabels);
        if (result) byBucket.set(cacheKey, result);
        return result;
      };
      const getView = Effect.fn('rpc.GetUsageView')(
        function* ({
          query,
          page,
          sort,
          bucket,
        }: {
          query: UsageQuery;
          page: number;
          sort?: SessionSort;
          bucket?: string;
        }) {
          const { input, cached } = yield* getAggregate(query);
          yield* warmer.visited(query);
          const catalog = yield* readFilterCatalog(input.normalized.devices);
          const response = cached.response;
          const base = getViewBase(response);
          const viewRevision = getViewRevision(response, JSON.stringify(input.query.models));
          const sessions = yield* sortedSessions(response.sessions, response.machine, sort);
          const sessionCount = sessions.length;
          const lastPage = Math.max(1, Math.ceil(sessionCount / sessionPageSize));
          const sessionOffset = (Math.min(page, lastPage) - 1) * sessionPageSize;
          const pageSessions = sessions
            .slice(sessionOffset, sessionOffset + sessionPageSize)
            .map((session) => projectViewSession(session, base.knownModels));
          const selectedBucket = bucket
            ? (getBucketForResponse(response, base, bucket, viewRevision, catalog.projectLabels) ?? undefined)
            : undefined;
          const labelKeys = [
            ...base.visibleProjects,
            ...pageSessions.map((session) => session.project),
            ...(input.normalized.projects ?? []),
          ];
          return {
            machine: base.machine,
            generatedAt: input.now.toISOString(),
            timezone: base.timezone,
            range: base.range,
            period: base.period,
            totals: base.totals,
            previous: base.previous,
            buckets: [...base.buckets],
            breakdown: base.breakdown,
            filterCounts: base.filterCounts,
            filterRevision: catalog.filters.filterRevision,
            projectLabels: projectProjectLabels(labelKeys, catalog.projectLabels),
            ...(selectedBucket ? { selectedBucket } : {}),
            sessions: pageSessions,
            sessionCount,
            sessionOffset,
            viewRevision,
          };
        },
        Effect.mapError((error) =>
          error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
        ),
      );
      return {
        GetUsage: getUsage,
        GetSessionExport: Effect.fn('rpc.GetSessionExport')(function* (query) {
          const { cached } = yield* getAggregate(query);
          return { period: cached.response.period, sessions: cached.response.sessions };
        }),
        GetUsagePage: getPage,
        GetUsagePageUpdate: Effect.fn('rpc.GetUsagePageUpdate')(function* (request) {
          const page = yield* getPage(request);
          // A rename can reorder device-sorted rows within the same usage revision.
          if (request.viewRevision !== page.viewRevision || request.sort?.by === 'device') return page;
          return {
            _tag: 'PageDelta' as const,
            viewRevision: page.viewRevision,
            generatedAt: page.generatedAt,
            sessionOffset: page.sessionOffset,
            ...(page.sessionOffset !== request.sessionOffset ? { sessions: page.sessions } : {}),
          };
        }),
        GetUsageView: getView,
        GetUsageViewUpdate: Effect.fn('rpc.GetUsageViewUpdate')(
          function* (request) {
            const { input, cached } = yield* getAggregate(request.query);
            yield* warmer.visited(request.query);
            const response = cached.response;
            const viewRevision = getViewRevision(response, JSON.stringify(input.query.models));
            if (request.viewRevision !== viewRevision || request.sort?.by === 'device') {
              return yield* getView(request);
            }
            const sessions = yield* sortedSessions(response.sessions, response.machine, request.sort);
            const sessionCount = sessions.length;
            const lastPage = Math.max(1, Math.ceil(sessionCount / sessionPageSize));
            const sessionOffset = (Math.min(request.page, lastPage) - 1) * sessionPageSize;
            if (sessionOffset === request.sessionOffset) {
              return {
                _tag: 'ViewDelta' as const,
                viewRevision,
                generatedAt: input.now.toISOString(),
                sessionOffset,
              };
            }
            const base = getViewBase(response);
            const catalog = yield* readFilterCatalog(input.normalized.devices);
            const pageSessions = sessions
              .slice(sessionOffset, sessionOffset + sessionPageSize)
              .map((session) => projectViewSession(session, base.knownModels));
            const labels = projectProjectLabels(
              pageSessions.map((session) => session.project),
              catalog.projectLabels,
            );
            return {
              _tag: 'ViewDelta' as const,
              viewRevision,
              generatedAt: input.now.toISOString(),
              sessionOffset,
              sessions: pageSessions,
              ...(labels.length ? { projectLabels: labels } : {}),
            };
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetUsageBucket: Effect.fn('rpc.GetUsageBucket')(
          function* ({ query, bucket }) {
            const { input, cached } = yield* getAggregate(query);
            const catalog = yield* readFilterCatalog(input.normalized.devices);
            const response = cached.response;
            const base = getViewBase(response);
            const viewRevision = getViewRevision(response, JSON.stringify(input.query.models));
            return getBucketForResponse(response, base, bucket, viewRevision, catalog.projectLabels);
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetUsageFilters: Effect.fn('rpc.GetUsageFilters')(
          function* ({ devices }) {
            return (yield* readFilterCatalog(devices)).filters;
          },
          Effect.mapError((error) =>
            error instanceof UsageFailure ? error : new UsageFailure({ message: error.message }),
          ),
        ),
        GetUsageInfo: Effect.fn('rpc.GetUsageInfo')(
          function* (query) {
            const input = yield* readQuery(query);
            const sources = [...input.current.sources, ...(yield* store.getSources(localDeviceId))];
            // Diagnostics depend on the prepared read window, not the rolling chart boundaries.
            const ready = dashboards.get(input.resultKey)?.response;
            if (ready) return { machine: ready.machine, pricing: ready.pricing, warnings: ready.warnings, sources };
            const { data } = yield* Cache.get(snapshots, input.readKey).pipe(
              Effect.provideService(SnapshotInput, { current: input.current, state: input.state }),
            );
            const { zone, requestedZone } = input.timeframe;
            return {
              machine: local.device?.name ?? 'All devices',
              sources,
              warnings:
                zone === requestedZone
                  ? data.warnings
                  : [...data.warnings, `Timezone ${requestedZone} is unavailable; displaying UTC.`],
              pricing: { method: pricingMethod, updatedAt: data.pricingUpdatedAt },
            };
          },
          Effect.mapError((error) => new UsageFailure({ message: error.message })),
        ),
        GetHubInfo: Effect.fn('rpc.GetHubInfo')(function* () {
          const devices = yield* store.getDevices();
          const localDevice = local.device && devices.find((row) => row.id === local.device?.id);
          const extra = local.device && !localDevice ? 1 : 0;
          const { info } = yield* pricing.load;
          return {
            version: releaseVersion,
            localDeviceName: localDevice?.name ?? local.device?.name ?? null,
            devices: devices.length + extra,
            activeDevices: devices.filter((row) => !row.revokedAt).length + extra,
            pricing: {
              source: info.source,
              updatedAt: info.updatedAt,
              checkedAt: info.checkedAt,
              refreshError: info.refreshError,
            },
          };
        }),
        GetPricing: getPricing,
        GetPricingCatalog: Effect.fn('rpc.GetPricingCatalog')(function* () {
          return { info: (yield* pricing.load).info, secretRequired: !options.trustBrowser };
        }),
        GetUnresolvedPricing: Effect.fn('rpc.GetUnresolvedPricing')(function* (query) {
          const { info, unresolved } = yield* getPricing(query);
          return { revision: info.revision, unresolved };
        }),
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
          return yield* listDevices();
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
        SyncUsage: ({ deviceId, token, batch }) =>
          store.syncUsage(deviceId, token, batch).pipe(Effect.tap(warmer.changed)),
        ImportUsage: ({ pairingSecret, batch }) =>
          store.importUsage(pairingSecret, batch).pipe(Effect.tap(warmer.changed)),
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
      return HttpServerResponse.jsonUnsafe({ status: 'ok', version: releaseVersion, devices: devices.length });
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
