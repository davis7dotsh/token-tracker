import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import { UsageRpc } from '../shared/rpc';
import type { UsageQuery } from '../shared/domain';
import type { PricingRule } from '../shared/pricing';

// This layer is shared by the browser and the CLI. The runtime owns the RPC
// scope; disposing it interrupts requests and releases transport resources.
export class UsageClient extends Context.Service<UsageClient>()('token-tracker/UsageClient', {
  make: RpcClient.make(UsageRpc),
}) {}

export const rpcClientLayer = (url: string) =>
  Layer.effect(UsageClient, UsageClient.make).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({
        url,
        // RPC posts to an empty path. Preserve the endpoint exactly instead
        // of inserting a trailing slash and paying for a SvelteKit redirect.
        transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.setUrl(url)),
      }).pipe(Layer.provide(Layer.mergeAll(FetchHttpClient.layer, RpcSerialization.layerNdjson))),
    ),
  );

const messageFor = (error: unknown) => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    if (error._tag === 'TimeoutError') return 'The dashboard took too long to respond. Try again.';
    if (error._tag === 'RpcClientError') return 'Could not reach the dashboard. Check your connection and try again.';
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return 'Could not load usage. Try again.';
};

export const makeDashboardClient = (url = '/rpc', options: { requestTimeoutMs?: number } = {}) => {
  const endpoint = typeof window === 'undefined' ? url : new URL(url, window.location.href).href;
  const runtime = ManagedRuntime.make(rpcClientLayer(endpoint));
  const timeout = Math.max(1, options.requestTimeoutMs ?? 10_000);

  const run = async <A, E>(program: Effect.Effect<A, E, UsageClient>, signal?: AbortSignal, deadline = timeout) => {
    const exit = await runtime.runPromiseExit(program.pipe(Effect.timeout(deadline)), { signal });
    if (Exit.isSuccess(exit)) return exit.value;
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    const failure = Cause.findErrorOption(exit.cause);
    throw new Error(messageFor(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)));
  };

  return {
    getUsage: (query: UsageQuery = {}, signal?: AbortSignal) =>
      run(
        Effect.flatMap(UsageClient, (client) => client.GetUsage(query)),
        signal,
      ),
    getDevices: (signal?: AbortSignal) =>
      run(
        Effect.flatMap(UsageClient, (client) => client.GetDevices()),
        signal,
      ),
    getPricing: (query: UsageQuery = {}, signal?: AbortSignal) =>
      run(
        Effect.flatMap(UsageClient, (client) => client.GetPricing(query)),
        signal,
      ),
    getPricingPolicy: (revision?: string) =>
      run(Effect.flatMap(UsageClient, (client) => client.GetPricingPolicy(revision === undefined ? {} : { revision }))),
    setPricingRule: (rule: PricingRule, adminSecret = '') =>
      run(Effect.flatMap(UsageClient, (client) => client.SetPricingRule({ rule, adminSecret }))),
    deletePricingRule: (model: string, adminSecret = '') =>
      run(Effect.flatMap(UsageClient, (client) => client.DeletePricingRule({ model, adminSecret }))),
    refreshPricing: (adminSecret = '') =>
      run(
        Effect.flatMap(UsageClient, (client) => client.RefreshPricing({ adminSecret })),
        undefined,
        20_000,
      ),
    dispose: () => runtime.dispose(),
  };
};
