import { Context, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import { UsageRpc } from '../shared/rpc';

export { makeDashboardClient } from './dashboard-rpc';

// The CLI's Effect layer shares the browser's wire protocol. The runtime owns the RPC
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
