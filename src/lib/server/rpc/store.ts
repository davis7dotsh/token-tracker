import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Device, SourceStatus, UsageEvent, type DeviceRegistration, type SyncBatch } from '../../shared/domain';
import { InvalidRequest, StorageFailure, Unauthorized } from '../../shared/rpc';

const storageFailure = () => new StorageFailure({ message: 'Could not access the dashboard’s usage database.' });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equalSecret = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));

export type ServerOptions = {
  dashboardOrigin?: string;
  readonly dataDirectory?: string;
  readonly pairingSecret?: string;
  readonly autoRefreshPricing?: boolean;
};

export class ServerConfiguration extends Context.Service<
  ServerConfiguration,
  {
    readonly databasePath: string;
    readonly pairingSecret: string;
  }
>()('token-tracker/ServerConfiguration') {}

export const configurationLayer = (options: ServerOptions = {}) =>
  Layer.effect(
    ServerConfiguration,
    Effect.tryPromise({
      try: async () => {
        const directory =
          options.dataDirectory ??
          process.env.TOKEN_TRACKER_DATA_DIR ??
          join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'token-tracker');
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
    }),
  );

const validateDevice = (device: DeviceRegistration) => {
  if (
    !device.id.trim() ||
    !device.name.trim() ||
    !device.platform.trim() ||
    device.id.length > 200 ||
    device.name.length > 200 ||
    device.platform.length > 100
  ) {
    return Effect.fail(new InvalidRequest({ message: 'A valid device ID, name, and platform are required.' }));
  }
  return Effect.void;
};

const eventJson = Schema.fromJsonString(UsageEvent);
const sourcesJson = Schema.fromJsonString(Schema.Array(SourceStatus));

export class UsageStore extends Context.Service<UsageStore>()('token-tracker/UsageStore', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const configuration = yield* ServerConfiguration;

    yield* sql
      .unsafe(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
      token_hash TEXT NOT NULL, last_seen TEXT,
      sources TEXT NOT NULL DEFAULT '[]', pricing_updated_at TEXT NOT NULL DEFAULT ''
    )`)
      .pipe(Effect.mapError(storageFailure));
    yield* sql
      .unsafe(`CREATE TABLE IF NOT EXISTS usage_events (
      device_id TEXT NOT NULL, id TEXT NOT NULL, timestamp TEXT NOT NULL,
      payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
      pricing_snapshot TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (device_id, id), FOREIGN KEY (device_id) REFERENCES devices(id)
    )`)
      .pipe(Effect.mapError(storageFailure));
    const columns = yield* sql
      .unsafe<{ name: string }>('PRAGMA table_info(usage_events)')
      .pipe(Effect.mapError(storageFailure));
    if (!columns.some((column) => column.name === 'pricing_snapshot')) {
      yield* sql
        .unsafe("ALTER TABLE usage_events ADD COLUMN pricing_snapshot TEXT NOT NULL DEFAULT ''")
        .pipe(Effect.mapError(storageFailure));
    }
    yield* sql
      .unsafe('CREATE INDEX IF NOT EXISTS usage_events_timestamp ON usage_events(timestamp)')
      .pipe(Effect.mapError(storageFailure));
    yield* Effect.tryPromise({ try: () => chmod(configuration.databasePath, 0o600), catch: storageFailure });

    const getDevices = Effect.fn('UsageStore.getDevices')(
      function* () {
        const rows = yield* sql`
        SELECT d.id, d.name, d.platform, d.last_seen AS lastSeen,
          (SELECT COUNT(*) FROM usage_events e WHERE e.device_id = d.id) AS eventCount
        FROM devices d ORDER BY d.name
      `;
        return yield* Schema.decodeUnknownEffect(Schema.Array(Device))(rows);
      },
      (effect) => Effect.mapError(effect, storageFailure),
    );

    const registerDevice = Effect.fn('UsageStore.registerDevice')(function* (
      pairingSecret: string,
      device: DeviceRegistration,
    ) {
      if (!equalSecret(pairingSecret, configuration.pairingSecret)) {
        return yield* Effect.fail(new Unauthorized({ message: 'The pairing secret is incorrect.' }));
      }
      yield* validateDevice(device);
      const token = randomBytes(32).toString('base64url');
      yield* sql`
        INSERT INTO devices (id, name, platform, token_hash)
        VALUES (${device.id}, ${device.name}, ${device.platform}, ${digest(token)})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name,
          platform = excluded.platform, token_hash = excluded.token_hash
      `.pipe(Effect.mapError(storageFailure));
      const devices = yield* getDevices();
      const registered = devices.find((item) => item.id === device.id);
      if (!registered) return yield* Effect.fail(storageFailure());
      return { device: registered, token };
    });

    const syncUsage = Effect.fn('UsageStore.syncUsage')(function* (deviceId: string, token: string, batch: SyncBatch) {
      yield* validateDevice(batch.device);
      if (batch.device.id !== deviceId)
        return yield* Effect.fail(new InvalidRequest({ message: 'The sync batch belongs to a different device.' }));
      if (batch.events.length + (batch.deletedIds?.length ?? 0) > 10_000) {
        return yield* Effect.fail(new InvalidRequest({ message: 'A sync batch can contain at most 10,000 records.' }));
      }
      for (const event of batch.events) {
        const amounts = [
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.reasoningTokens,
          event.costUsd,
        ];
        if (
          !event.id ||
          !Number.isFinite(Date.parse(event.timestamp)) ||
          amounts.some((value) => !Number.isFinite(value) || value < 0)
        ) {
          return yield* Effect.fail(
            new InvalidRequest({
              message: 'Usage records need a stable ID, a valid timestamp, and nonnegative token counts and cost.',
            }),
          );
        }
      }

      // Authentication, every upsert/deletion, and the durable last-seen marker
      // share one transaction. A cancelled or failed batch is never acknowledged.
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const credentials = yield* sql<{
              token_hash: string;
            }>`SELECT token_hash FROM devices WHERE id = ${deviceId}`;
            if (!credentials[0] || !equalSecret(digest(token), credentials[0].token_hash)) {
              return yield* Effect.fail(
                new Unauthorized({
                  message: 'This device is not connected, or its credential has expired. Connect it again.',
                }),
              );
            }
            let accepted = 0;
            let updated = 0;
            let deleted = 0;
            const pricingSnapshot = batch.pricingUpdatedAt?.trim() ?? '';
            for (const event of batch.events) {
              const normalized = { ...event, deviceId, costUsd: event.costKnown ? event.costUsd : 0 };
              const payload = JSON.stringify(normalized);
              const payloadHash = digest(JSON.stringify([pricingSnapshot, payload]));
              const existing = yield* sql<{ payload_hash: string }>`
            SELECT payload_hash FROM usage_events WHERE device_id = ${deviceId} AND id = ${event.id}
          `;
              if (existing[0]?.payload_hash === payloadHash) continue;
              yield* sql`
            INSERT INTO usage_events (device_id, id, timestamp, payload, payload_hash, pricing_snapshot)
            VALUES (${deviceId}, ${event.id}, ${event.timestamp}, ${payload}, ${payloadHash}, ${pricingSnapshot})
            ON CONFLICT (device_id, id) DO UPDATE SET timestamp = excluded.timestamp,
              payload = excluded.payload, payload_hash = excluded.payload_hash,
              pricing_snapshot = excluded.pricing_snapshot
          `;
              if (existing.length === 0) accepted += 1;
              else updated += 1;
            }
            for (const id of batch.deletedIds ?? []) {
              const rows = yield* sql<{
                id: string;
              }>`DELETE FROM usage_events WHERE device_id = ${deviceId} AND id = ${id} RETURNING id`;
              deleted += rows.length;
            }
            const receivedAt = new Date().toISOString();
            yield* sql`UPDATE devices SET name = ${batch.device.name}, platform = ${batch.device.platform}, last_seen = ${receivedAt} WHERE id = ${deviceId}`;
            if (batch.sources)
              yield* sql`UPDATE devices SET sources = ${JSON.stringify(batch.sources)} WHERE id = ${deviceId}`;
            if (batch.pricingUpdatedAt)
              yield* sql`UPDATE devices SET pricing_updated_at = ${batch.pricingUpdatedAt} WHERE id = ${deviceId}`;
            return { accepted, updated, deleted, receivedAt };
          }),
        )
        .pipe(Effect.catchTag('SqlError', () => Effect.fail(storageFailure())));
    });

    const getUsage = Effect.fn('UsageStore.getUsage')(
      function* (excludeDeviceId?: string) {
        const rows = yield* sql<{ id: string; device_id: string; payload: string; pricing_snapshot: string }>`
        SELECT id, device_id, payload, pricing_snapshot FROM usage_events
        WHERE device_id <> ${excludeDeviceId ?? ''} ORDER BY timestamp
      `;
        const metadata = yield* sql<{ name: string; sources: string; pricing_updated_at: string }>`
        SELECT name, sources, pricing_updated_at FROM devices WHERE id <> ${excludeDeviceId ?? ''}
      `;
        const events = yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(eventJson)(row.payload));
        const sources = yield* Effect.forEach(metadata, (row) =>
          Schema.decodeUnknownEffect(sourcesJson)(row.sources).pipe(
            Effect.map((sources) => sources.map((source) => ({ ...source, path: `${row.name} · ${source.path}` }))),
          ),
        );
        return {
          events,
          sources: sources.flat(),
          warnings: [],
          pricingSnapshots: rows.map((row) => ({
            eventId: row.id,
            deviceId: row.device_id,
            updatedAt: row.pricing_snapshot,
          })),
          pricingUpdatedAt:
            metadata
              .map((row) => row.pricing_updated_at)
              .sort()
              .at(-1) ?? '',
        };
      },
      (effect, _excludeDeviceId?: string) => Effect.mapError(effect, storageFailure),
    );

    const authorizePricing = (secret: string) =>
      equalSecret(secret, configuration.pairingSecret)
        ? Effect.void
        : Effect.fail(new Unauthorized({ message: 'Pricing changes require the dashboard or its pairing secret.' }));
    return {
      getDevices,
      registerDevice,
      syncUsage,
      getUsage,
      authorizePricing,
      pricingDirectory: dirname(configuration.databasePath),
    };
  }),
}) {}

export const usageStoreLayer = (options: ServerOptions = {}) => {
  const configuration = configurationLayer(options);
  const database = Layer.unwrap(
    Effect.map(ServerConfiguration, (config) => SqliteClient.layer({ filename: config.databasePath })),
  );
  return Layer.effect(UsageStore, UsageStore.make).pipe(Layer.provide(Layer.provideMerge(database, configuration)));
};
