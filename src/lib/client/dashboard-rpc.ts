import type { Rpc, RpcGroup } from 'effect/rpc';
import type { UsageRpc } from '../shared/rpc';
import type { UsageQuery } from '../shared/domain';
import type { PricingRule } from '../shared/pricing';

type Procedures = RpcGroup.Rpcs<typeof UsageRpc>;
type Procedure<Tag extends Procedures['_tag']> = Extract<Procedures, { readonly _tag: Tag }>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const unreachable = 'Could not reach the dashboard. Check your connection and try again.';
const timedOut = 'The dashboard took too long to respond. Try again.';
const unavailable = 'Could not load usage. Try again.';

// The server validates requests and schema-encodes every successful result.
// This unary browser transport checks the Effect NDJSON envelope while keeping
// the shared RPC types, without shipping the collector's Effect runtime.
const readResult = (body: string, id: string) => {
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
        if (record(cause) && cause._tag === 'Fail' && record(cause.error) && typeof cause.error.message === 'string')
          throw new Error(cause.error.message);
      }
    }
    throw new Error(unavailable);
  }
  throw new Error(unavailable);
};

export const makeDashboardClient = (url = '/rpc', options: { requestTimeoutMs?: number } = {}) => {
  const endpoint = typeof window === 'undefined' ? url : new URL(url, window.location.href).href;
  const timeout = Math.max(1, options.requestTimeoutMs ?? 10_000);
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
          const response = await fetch(endpoint, {
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
        // UsageRpc owns the payload schema and encodes it at the server boundary.
        // This assertion bridges that validated wire value to the matching RPC.
        return readResult(body, id) as Rpc.Success<Procedure<Tag>>;
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

  return {
    getUsage: (query: UsageQuery = {}, signal?: AbortSignal) => call('GetUsage', query, signal, usageTimeout),
    getDevices: (signal?: AbortSignal) => call('GetDevices', undefined, signal),
    getPricing: (query: UsageQuery = {}, signal?: AbortSignal) => call('GetPricing', query, signal),
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
