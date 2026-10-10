import { SqliteClient } from '@effect/sql-sqlite-bun';
import { BunHttpPlatform, BunServices } from '@effect/platform-bun';
import { Effect, FileSystem, Layer, Path, Result } from 'effect';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { StorageFailure } from '../../shared/rpc';
import { collectUsage } from '../usage';
import { filePricing } from '../usage/pricing-runtime';
import { HubPricing, LocalUsage, makeHubWebHandler } from './hub';
import { getLocalDevice } from './identity';
import { ServerConfiguration, UsageStore } from './store';

export { LocalUsage } from './hub';

export type ServerOptions = {
  dashboardOrigin?: string;
  readonly dataDirectory?: string;
  readonly pairingSecret?: string;
  readonly autoRefreshPricing?: boolean;
};

const dataDirectory = (options: ServerOptions) =>
  options.dataDirectory ??
  process.env.TOKEN_TRACKER_DATA_DIR ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'token-tracker');

// A self-hosted hub keeps its database, pairing secret, and pricing state in a
// private data directory.
const hubFiles = (options: ServerOptions) =>
  Effect.tryPromise({
    try: async () => {
      const directory = dataDirectory(options);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let pairingSecret = options.pairingSecret ?? process.env.TOKEN_TRACKER_PAIRING_SECRET;
      if (!pairingSecret) {
        const secretPath = join(directory, 'pairing-secret');
        try {
          pairingSecret = (await readFile(secretPath, 'utf8')).trim();
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (!pairingSecret) {
          pairingSecret = randomBytes(32).toString('base64url');
          try {
            await writeFile(secretPath, `${pairingSecret}\n`, { flag: 'wx', mode: 0o600 });
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
              pairingSecret = (await readFile(secretPath, 'utf8')).trim();
            else throw error;
          }
        }
      }
      if (pairingSecret.length < 16) throw new Error('Pairing secret must be at least 16 characters.');
      return { databasePath: join(directory, 'usage.sqlite'), pairingSecret };
    },
    catch: () =>
      new StorageFailure({
        message:
          'Could not initialize dashboard storage. Check the data directory and pairing secret (at least 16 characters).',
      }),
  });

export const usageStoreLayer = (options: ServerOptions = {}) =>
  Layer.unwrap(
    Effect.map(hubFiles(options), ({ databasePath, pairingSecret }) =>
      Layer.effect(
        UsageStore,
        UsageStore.make.pipe(
          Effect.tap(() =>
            Effect.tryPromise({
              try: () => chmod(databasePath, 0o600),
              catch: () => new StorageFailure({ message: 'Could not access the dashboard’s usage database.' }),
            }),
          ),
        ),
      ).pipe(
        Layer.provide(SqliteClient.layer({ filename: databasePath })),
        Layer.provide(Layer.succeed(ServerConfiguration, { pairingSecret })),
      ),
    ),
  );

export const filePricingLayer = (options: ServerOptions = {}) =>
  Layer.sync(HubPricing, () => filePricing(options.dataDirectory));

export const localUsageLayer = Layer.effect(
  LocalUsage,
  Effect.gen(function* () {
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
).pipe(Layer.provide(BunServices.layer));

// The self-hosted hub serves CLI packages from TOKEN_TRACKER_DOWNLOAD_DIR.
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

export const makeRpcWebHandler = (options: ServerOptions = {}, localLayer = localUsageLayer) => {
  const services = Layer.mergeAll(usageStoreLayer(options), filePricingLayer(options), localLayer);
  // adapter-node may reconstruct HTTP requests with an HTTPS scheme. Use the
  // deployment's explicit public origin when one is configured.
  const publicOrigin = options.dashboardOrigin ?? process.env.ORIGIN?.trim();
  // Tailnet access is the dashboard's owner boundary in this personal mode.
  return makeHubWebHandler(
    services,
    {
      trustBrowser: true,
      autoRefreshPricing: options.autoRefreshPricing ?? localLayer === localUsageLayer,
      ...(publicOrigin ? { expectedOrigin: new URL(publicOrigin).origin } : {}),
    },
    downloads,
  );
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
