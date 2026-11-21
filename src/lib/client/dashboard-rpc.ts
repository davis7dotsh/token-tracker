import type { Rpc, RpcGroup } from 'effect/rpc';
import type { UsageRpc } from '../shared/rpc';
import type { DashboardPage, DashboardView, SessionSort, UsageQuery } from '../shared/domain';
import { sessionPageSize } from '../shared/dashboard-page';
import { groupDashboardBuckets, projectBucketBreakdown, projectDashboardViewFromPage } from '../shared/dashboard-view';
import { projectLabels } from '../shared/project-label';
import type { PricingRule } from '../shared/pricing';
import {
  isDashboardBucketBreakdown,
  isDashboardPage,
  isDashboardResponse,
  isDashboardView,
  isSessionExport,
  isPageDelta,
  isUsageFilters,
  isViewDelta,
  isHubInfo,
  isUsageInfo,
} from './dashboard-response';

type Procedures = RpcGroup.Rpcs<typeof UsageRpc>;
type Procedure<Tag extends Procedures['_tag']> = Extract<Procedures, { readonly _tag: Tag }>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const unreachable = 'Could not reach the dashboard. Check your connection and try again.';
const timedOut = 'The dashboard took too long to respond. Try again.';
const unavailable = 'Could not load usage. Try again.';

// The server validates requests and schema-encodes every successful result.
// This unary browser transport checks the Effect NDJSON envelope and dashboard
// result shape without shipping the collector's Effect runtime.
class ProcedureUnavailable extends Error {}
const readResult = (body: string, id: string, tag: Procedures['_tag']) => {
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(unavailable);
    }
    if (!record(message)) throw new Error(unavailable);
    if (message._tag === 'Defect') throw new Error(unavailable);
    if (message._tag !== 'Exit' || String(message.requestId) !== id) continue;
    const exit = message.exit;
    if (!record(exit)) throw new Error(unavailable);
    if (exit._tag === 'Success' && 'value' in exit) return exit.value;
    if (exit._tag === 'Failure' && Array.isArray(exit.cause)) {
      for (const cause of exit.cause) {
        if (
          exit.cause.length === 1 &&
          record(cause) &&
          cause._tag === 'Die' &&
          cause.defect === `Unknown request tag: ${tag}`
        )
          throw new ProcedureUnavailable(unavailable);
        if (record(cause) && cause._tag === 'Fail' && record(cause.error) && typeof cause.error.message === 'string')
          throw new Error(cause.error.message);
      }
    }
    throw new Error(unavailable);
  }
  throw new Error(unavailable);
};

// Keep cache accounting off the render path: reuse the already decoded wire length.
const pageSizes = new WeakMap<object, number>();
const commonSizes = new WeakMap<object, number>();
export const usagePageSize = (value: DashboardPage) => pageSizes.get(value) ?? Infinity;
export const usageViewSize = (value: DashboardView) => pageSizes.get(value) ?? Infinity;

export const makeDashboardClient = (
  url = '/rpc',
  options: { requestTimeoutMs?: number; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
) => {
  const endpoint = typeof window === 'undefined' ? url : new URL(url, window.location.href).href;
  const timeout = Math.max(1, options.requestTimeoutMs ?? 10_000);
  // Pricing settings scan usage for unpriced models, so they share the usage budget.
  const usageTimeout = Math.max(1, options.requestTimeoutMs ?? 30_000);
  const active = new Map<AbortController, Promise<unknown>>();
  let disposed = false;
  let nextId = 0;

  const call = <Tag extends Procedures['_tag']>(
    tag: Tag,
    payload: Rpc.Payload<Procedure<Tag>>,
    signal?: AbortSignal,
    deadline = timeout,
  ) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || disposed) controller.abort();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, deadline);
    const id = String(++nextId);
    const pending = (async () => {
      try {
        let body: string;
        try {
          const response = await (options.fetch ?? fetch)(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/ndjson' },
            body: `${JSON.stringify({ _tag: 'Request', id, tag, payload: payload ?? null, headers: [] })}\n`,
            signal: controller.signal,
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error(unreachable);
          body = await response.text();
        } catch {
          throw new Error(unreachable);
        }
        const result = readResult(body, id, tag);
        if (tag === 'GetSessionExport' && !isSessionExport(result)) throw new Error(unavailable);
        if (tag === 'GetUsage' && !isDashboardResponse(result)) throw new Error(unavailable);
        if (tag === 'GetUsagePage' || tag === 'GetUsagePageUpdate') {
          if (tag === 'GetUsagePageUpdate' && isPageDelta(result)) pageSizes.set(result, body.length * 2);
          else {
            if (!isDashboardPage(result)) throw new Error(unavailable);
            pageSizes.set(result, body.length * 2);
            commonSizes.set(result.daily, body.length * 2);
          }
        }
        if (tag === 'GetUsageView' || tag === 'GetUsageViewUpdate') {
          if (tag === 'GetUsageViewUpdate' && isViewDelta(result)) pageSizes.set(result, body.length * 2);
          else {
            if (!isDashboardView(result)) throw new Error(unavailable);
            pageSizes.set(result, body.length * 2);
            commonSizes.set(result.buckets, body.length * 2);
          }
        }
        if (tag === 'GetUsageBucket' && result !== null && !isDashboardBucketBreakdown(result))
          throw new Error(unavailable);
        if (tag === 'GetUsageFilters' && !isUsageFilters(result)) throw new Error(unavailable);
        if (tag === 'GetHubInfo' && !isHubInfo(result)) throw new Error(unavailable);
        if (tag === 'GetUsageInfo' && !isUsageInfo(result)) throw new Error(unavailable);
        // UsageRpc encodes all results; the dashboard guard also rejects
        // incompatible successful payloads before they reach reactive state.
        return result as Rpc.Success<Procedure<Tag>>;
      } catch (error) {
        if (signal?.aborted || disposed) throw new DOMException('Request cancelled', 'AbortError');
        if (expired) throw new Error(timedOut);
        throw error instanceof Error ? error : new Error(unavailable);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active.delete(controller);
      }
    })();
    active.set(controller, pending);
    return pending;
  };

  const legacyPages = new Map<string, DashboardPage>();
  const legacyQueryKey = (query: UsageQuery) => JSON.stringify(query);
  const rememberLegacyPage = (query: UsageQuery, legacy: DashboardPage) => {
    const key = legacyQueryKey(query);
    legacyPages.delete(key);
    legacyPages.set(key, legacy);
    if (legacyPages.size > 4) {
      const oldest = legacyPages.keys().next();
      if (!oldest.done) legacyPages.delete(oldest.value);
    }
  };
  const projectLegacyBucket = (legacy: DashboardPage, bucket: string) =>
    projectBucketBreakdown(
      groupDashboardBuckets(legacy),
      bucket,
      legacy.viewRevision ?? '',
      projectLabels(legacy.filters.projects),
    );

  return {
    getUsage: (query: UsageQuery = {}, signal?: AbortSignal) => call('GetUsage', query, signal, usageTimeout),
    getSessionExport: (query: UsageQuery, signal?: AbortSignal) =>
      call('GetSessionExport', query, signal, usageTimeout).catch((error: unknown) => {
        if (error instanceof ProcedureUnavailable) return call('GetUsage', query, signal, usageTimeout);
        throw error;
      }),
    // `base` must be a page of the same query and sort: an unchanged offset reuses its rows.
    getUsagePage: async (
      query: UsageQuery,
      page: number,
      signal?: AbortSignal,
      base?: DashboardPage,
      sort?: SessionSort,
    ) => {
      const sorted = sort ? { sort } : {};
      if (!base?.viewRevision) return call('GetUsagePage', { query, page, ...sorted }, signal, usageTimeout);
      const result = await call(
        'GetUsagePageUpdate',
        { query, page, ...sorted, viewRevision: base.viewRevision, sessionOffset: base.sessionOffset },
        signal,
        usageTimeout,
      ).catch((error: unknown) => {
        // A tab may outlive a server rollback. Only an explicit missing method
        // retries on the original RPC; auth, timeout and transport errors stand.
        if (error instanceof ProcedureUnavailable)
          return call('GetUsagePage', { query, page, ...sorted }, signal, usageTimeout);
        throw error;
      });
      if (!('_tag' in result)) return result;
      const offset =
        Math.min(page - 1, Math.max(0, Math.ceil(base.sessionCount / sessionPageSize) - 1)) * sessionPageSize;
      if (
        result.viewRevision !== base.viewRevision ||
        result.sessionOffset !== offset ||
        (result.sessions
          ? result.sessions.length !== Math.min(sessionPageSize, base.sessionCount - offset)
          : offset !== base.sessionOffset)
      )
        throw new Error(unavailable);
      const next = {
        ...base,
        generatedAt: result.generatedAt,
        sessionOffset: offset,
        sessions: result.sessions ?? base.sessions,
      };
      // Charge the shared charts once per cache entry, conservatively. Don't let
      // repeated patches either accumulate fictitious bytes or hide a large page.
      pageSizes.set(
        next,
        result.sessions
          ? (commonSizes.get(base.daily) ?? Infinity) + (pageSizes.get(result) ?? Infinity)
          : usagePageSize(base),
      );
      return next;
    },
    getUsageView: async (
      query: UsageQuery,
      page: number,
      signal?: AbortSignal,
      base?: DashboardView,
      sort?: SessionSort,
      bucket?: string,
    ): Promise<DashboardView> => {
      const sorted = sort ? { sort } : {};
      const scopedBucket = bucket ? { bucket } : {};
      const fallback = async () => {
        const legacy = await call('GetUsagePage', { query, page, ...sorted }, signal, usageTimeout);
        rememberLegacyPage(query, legacy);
        const projected = projectDashboardViewFromPage(legacy, query, bucket);
        pageSizes.set(projected, usagePageSize(legacy));
        commonSizes.set(projected.buckets, usagePageSize(legacy));
        return projected;
      };
      if (!base?.viewRevision) {
        return call('GetUsageView', { query, page, ...sorted, ...scopedBucket }, signal, usageTimeout).catch(
          (error: unknown) => {
            if (error instanceof ProcedureUnavailable) return fallback();
            throw error;
          },
        );
      }
      const result = await call(
        'GetUsageViewUpdate',
        {
          query,
          page,
          ...sorted,
          ...scopedBucket,
          viewRevision: base.viewRevision,
          sessionOffset: base.sessionOffset,
        },
        signal,
        usageTimeout,
      ).catch((error: unknown) => {
        if (error instanceof ProcedureUnavailable) return fallback();
        throw error;
      });
      if (!('_tag' in result)) return result;
      const offset =
        Math.min(page - 1, Math.max(0, Math.ceil(base.sessionCount / sessionPageSize) - 1)) * sessionPageSize;
      if (
        result.viewRevision !== base.viewRevision ||
        result.sessionOffset !== offset ||
        (result.sessions
          ? result.sessions.length !== Math.min(sessionPageSize, base.sessionCount - offset)
          : offset !== base.sessionOffset)
      )
        throw new Error(unavailable);
      const mergedLabels = result.projectLabels?.length
        ? [...new Map([...base.projectLabels, ...result.projectLabels].map((entry) => [entry.key, entry])).values()]
        : base.projectLabels;
      const next: DashboardView = {
        ...base,
        generatedAt: result.generatedAt,
        sessionOffset: offset,
        sessions: result.sessions ?? base.sessions,
        projectLabels: mergedLabels,
      };
      pageSizes.set(
        next,
        result.sessions
          ? (commonSizes.get(base.buckets) ?? Infinity) + (pageSizes.get(result) ?? Infinity)
          : usageViewSize(base),
      );
      return next;
    },
    getUsageBucket: (query: UsageQuery, bucket: string, signal?: AbortSignal) =>
      call('GetUsageBucket', { query, bucket }, signal, usageTimeout).catch(async (error: unknown) => {
        if (error instanceof ProcedureUnavailable) {
          const cached = legacyPages.get(legacyQueryKey(query));
          if (cached) return projectLegacyBucket(cached, bucket);
          const legacy = await call('GetUsagePage', { query, page: 1 }, signal, usageTimeout);
          rememberLegacyPage(query, legacy);
          return projectLegacyBucket(legacy, bucket);
        }
        throw error;
      }),
    getUsageFilters: (devices?: readonly string[], signal?: AbortSignal) =>
      call('GetUsageFilters', devices ? { devices } : {}, signal, usageTimeout).catch(async (error: unknown) => {
        if (error instanceof ProcedureUnavailable) {
          const legacy = await call(
            'GetUsage',
            devices ? { devices, range: 'today' } : { range: 'today' },
            signal,
            usageTimeout,
          );
          return {
            filterRevision: legacy.generatedAt,
            harnesses: [...legacy.filters.harnesses],
            models: [...legacy.filters.models],
            providers: [...legacy.filters.providers],
            projects: [...legacy.filters.projects],
            devices: [...legacy.filters.devices],
          };
        }
        throw error;
      }),
    getUsageInfo: (query: UsageQuery, signal?: AbortSignal) => call('GetUsageInfo', query, signal, usageTimeout),
    getHubInfo: (signal?: AbortSignal) => call('GetHubInfo', undefined, signal),
    getDevices: (signal?: AbortSignal) => call('GetDevices', undefined, signal),
    getAdminAccess: (signal?: AbortSignal) => call('GetAdminAccess', undefined, signal),
    renameDevice: (deviceId: string, name: string, adminSecret = '') =>
      call('RenameDevice', { deviceId, name, adminSecret }),
    revokeDevice: (deviceId: string, adminSecret = '') => call('RevokeDevice', { deviceId, adminSecret }),
    restoreDevice: (deviceId: string, adminSecret = '') => call('RestoreDevice', { deviceId, adminSecret }),
    getPricingCatalog: (signal?: AbortSignal) => call('GetPricingCatalog', undefined, signal),
    getUnresolvedPricing: (query: UsageQuery, signal?: AbortSignal) =>
      call('GetUnresolvedPricing', query, signal, usageTimeout),
    getPricing: (query: UsageQuery = {}, signal?: AbortSignal) => call('GetPricing', query, signal, usageTimeout),
    getPricingPolicy: (revision?: string) => call('GetPricingPolicy', revision === undefined ? {} : { revision }),
    setPricingRule: (rule: PricingRule, adminSecret = '') => call('SetPricingRule', { rule, adminSecret }),
    deletePricingRule: (model: string, adminSecret = '') => call('DeletePricingRule', { model, adminSecret }),
    refreshPricing: (adminSecret = '') => call('RefreshPricing', { adminSecret }, undefined, 20_000),
    dispose: async () => {
      disposed = true;
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled(active.values());
    },
  };
};

let tab: ReturnType<typeof makeDashboardClient> | undefined;
// Settings writes outlive the page that started them: leaving Settings disposes
// its client and aborts reads, but writes sent through this one still reach the
// hub. It is never disposed. One per browser tab.
export const tabClient = () => {
  if (typeof window === 'undefined') return undefined;
  tab ??= makeDashboardClient();
  return tab;
};
