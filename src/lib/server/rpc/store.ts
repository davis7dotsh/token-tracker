import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Cache, Context, Effect, Exit, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Device,
  Harness,
  SourceStatus,
  UsageEvent,
  type DeviceRegistration,
  type SyncBatch,
} from '../../shared/domain';
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
const decodeEvent = Schema.decodeUnknownSync(eventJson);
const decodeSources = Schema.decodeUnknownSync(sourcesJson);
const UsageDimension = Schema.Struct({
  deviceId: Schema.String,
  harness: Harness,
  model: Schema.String,
  project: Schema.String,
});
const decodeDimensions = Schema.decodeUnknownSync(Schema.Array(UsageDimension));
export type UsageReadOptions = {
  start?: string;
  end?: string;
  devices?: readonly string[];
  candidateIds?: readonly string[];
};
const dimensionValues = (record: 'NEW' | 'OLD') => [
  `${record}.device_id`,
  `json_extract(${record}.payload, '$.harness')`,
  `COALESCE(json_extract(${record}.payload, '$.rawModel'), json_extract(${record}.payload, '$.model'))`,
  `COALESCE(json_extract(${record}.payload, '$.repository'), json_extract(${record}.payload, '$.project'))`,
];
const addDimension = (record: 'NEW' | 'OLD') => `
  INSERT INTO usage_dimensions (device_id, harness, model, project, records)
  VALUES (${dimensionValues(record).join(', ')}, 1)
  ON CONFLICT (device_id, harness, model, project) DO UPDATE SET records = records + 1;`;
const removeDimension = (record: 'NEW' | 'OLD') => {
  const where = dimensionValues(record)
    .map((value, index) => `${['device_id', 'harness', 'model', 'project'][index]} = ${value}`)
    .join(' AND ');
  return `UPDATE usage_dimensions SET records = records - 1 WHERE ${where};
    DELETE FROM usage_dimensions WHERE ${where} AND records = 0;`;
};

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
    yield* sql
      .unsafe('CREATE INDEX IF NOT EXISTS usage_events_record_id ON usage_events(id)')
      .pipe(Effect.mapError(storageFailure));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe('CREATE TABLE IF NOT EXISTS usage_migrations (name TEXT PRIMARY KEY)');
          const migrated = yield* sql`SELECT name FROM usage_migrations WHERE name = 'utc-timestamps-v1'`;
          if (!migrated.length) {
            // Date.parse accepts timezone forms and fractional precision that SQLite
            // does not. Normalize the indexed column, preserving the original payload/hash.
            const legacy = yield* sql<{
              device_id: string;
              id: string;
              timestamp: string;
            }>`SELECT device_id, id, timestamp FROM usage_events
          WHERE (timestamp NOT LIKE '____-__-__T__:__:__.___Z' AND timestamp NOT LIKE '_______-__-__T__:__:__.___Z') OR substr(timestamp, 12, 2) = '24'`;
            for (const row of legacy) {
              yield* sql`UPDATE usage_events SET timestamp = ${new Date(row.timestamp).toISOString()} WHERE device_id = ${row.device_id} AND id = ${row.id}`;
            }
            yield* sql`INSERT INTO usage_migrations (name) VALUES ('utc-timestamps-v1')`;
          }
        }),
      )
      .pipe(Effect.mapError(storageFailure));
    // Keep active filter dimensions and device counts in SQLite. Repeated reads
    // must not decode a million payloads just to populate five small dropdowns.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_dimensions'`;
          yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS usage_dimensions (
        device_id TEXT NOT NULL, harness TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL,
        records INTEGER NOT NULL, PRIMARY KEY (device_id, harness, model, project)
      ) WITHOUT ROWID`);
          if (!existing.length) {
            yield* sql.unsafe(`INSERT INTO usage_dimensions
          SELECT device_id, json_extract(payload, '$.harness'),
            COALESCE(json_extract(payload, '$.rawModel'), json_extract(payload, '$.model')),
            COALESCE(json_extract(payload, '$.repository'), json_extract(payload, '$.project')), COUNT(*)
          FROM usage_events GROUP BY 1, 2, 3, 4`);
          }
          yield* sql.unsafe(
            `CREATE TRIGGER IF NOT EXISTS usage_dimensions_insert AFTER INSERT ON usage_events BEGIN ${addDimension('NEW')} END`,
          );
          yield* sql.unsafe(
            `CREATE TRIGGER IF NOT EXISTS usage_dimensions_delete AFTER DELETE ON usage_events BEGIN ${removeDimension('OLD')} END`,
          );
          const changed = dimensionValues('OLD')
            .map((value, index) => `${value} IS NOT ${dimensionValues('NEW')[index]}`)
            .join(' OR ');
          yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS usage_dimensions_update AFTER UPDATE OF payload ON usage_events
        WHEN ${changed} BEGIN ${removeDimension('OLD')} ${addDimension('NEW')} END`);
        }),
      )
      .pipe(Effect.mapError(storageFailure));
    yield* Effect.tryPromise({ try: () => chmod(configuration.databasePath, 0o600), catch: storageFailure });
    let revision = 0;
    let ownerRevision = 0;
    let copiedRevision = -1;
    let copiedIds = new Set<string>();

    const getDevices = Effect.fn('UsageStore.getDevices')(
      function* () {
        const rows = yield* sql`
        SELECT d.id, d.name, d.platform, d.last_seen AS lastSeen,
          COALESCE((SELECT SUM(records) FROM usage_dimensions e WHERE e.device_id = d.id), 0) AS eventCount
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
      revision++;
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
          ...(event.reportedCostUsd === undefined ? [] : [event.reportedCostUsd]),
        ];
        if (
          !event.id ||
          !Number.isFinite(Date.parse(event.timestamp)) ||
          amounts.some((value) => !Number.isFinite(value) || value < 0) ||
          (event.requests !== undefined && (!Number.isSafeInteger(event.requests) || event.requests < 0))
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
      const result = yield* sql
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
            const existingRows = batch.events.length
              ? yield* sql.unsafe<{ id: string; payload_hash: string }>(
                  `SELECT id, payload_hash FROM usage_events WHERE device_id = ? AND id IN (${batch.events.map(() => '?').join(', ')})`,
                  [deviceId, ...batch.events.map((event) => event.id)],
                )
              : [];
            const existing = new Map(existingRows.map((row) => [row.id, row.payload_hash]));
            const changedRows: {
              device_id: string;
              id: string;
              timestamp: string;
              payload: string;
              payload_hash: string;
              pricing_snapshot: string;
            }[] = [];
            for (const event of batch.events) {
              const normalized = { ...event, deviceId, costUsd: event.costKnown ? event.costUsd : 0 };
              const payload = JSON.stringify(normalized);
              const payloadHash = digest(JSON.stringify([pricingSnapshot, payload]));
              const previous = existing.get(event.id);
              if (previous === payloadHash) continue;
              changedRows.push({
                device_id: deviceId,
                id: event.id,
                timestamp: new Date(event.timestamp).toISOString(),
                payload,
                payload_hash: payloadHash,
                pricing_snapshot: pricingSnapshot,
              });
              if (previous === undefined) accepted += 1;
              else updated += 1;
              existing.set(event.id, payloadHash);
            }
            for (let offset = 0; offset < changedRows.length; offset += 256) {
              const chunk = changedRows.slice(offset, offset + 256);
              yield* sql.unsafe(
                `INSERT INTO usage_events (device_id, id, timestamp, payload, payload_hash, pricing_snapshot)
                VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
                ON CONFLICT (device_id, id) DO UPDATE SET timestamp = excluded.timestamp,
                payload = excluded.payload, payload_hash = excluded.payload_hash, pricing_snapshot = excluded.pricing_snapshot`,
                chunk.flatMap((row) => [
                  row.device_id,
                  row.id,
                  row.timestamp,
                  row.payload,
                  row.payload_hash,
                  row.pricing_snapshot,
                ]),
              );
              yield* Effect.yieldNow;
            }
            const deletedIds = batch.deletedIds ?? [];
            for (let offset = 0; offset < deletedIds.length; offset += 256) {
              const ids = deletedIds.slice(offset, offset + 256);
              const rows = yield* sql.unsafe(
                `DELETE FROM usage_events WHERE device_id = ? AND id IN (${ids.map(() => '?').join(', ')}) RETURNING id`,
                [deviceId, ...ids],
              );
              deleted += rows.length;
            }
            const receivedAt = new Date().toISOString();
            yield* sql`UPDATE devices SET name = ${batch.device.name}, platform = ${batch.device.platform}, last_seen = ${receivedAt},
              sources = COALESCE(${batch.sources ? JSON.stringify(batch.sources) : null}, sources),
              pricing_updated_at = COALESCE(${batch.pricingUpdatedAt || null}, pricing_updated_at) WHERE id = ${deviceId}`;
            return { accepted, updated, deleted, receivedAt };
          }),
        )
        .pipe(Effect.catchTag('SqlError', () => Effect.fail(storageFailure())));
      if (result.accepted || result.updated || result.deleted) revision++;
      if (result.accepted || result.deleted) ownerRevision++;
      return result;
    });

    const readWindow = Effect.fn('UsageStore.readWindow')(
      function* (excludeDeviceId?: string, options: UsageReadOptions = {}) {
        const filters = ['device_id <> ?'];
        const parameters: string[] = [excludeDeviceId ?? ''];
        if (options.devices) {
          filters.push(options.devices.length ? `device_id IN (${options.devices.map(() => '?').join(', ')})` : '0');
          parameters.push(...options.devices);
        }
        const ownerFilter = filters.join(' AND ');
        const window = [];
        const windowParameters: string[] = [];
        if (options.start) {
          window.push('timestamp >= ?');
          windowParameters.push(options.start);
        }
        if (options.end) {
          window.push('timestamp < ?');
          windowParameters.push(options.end);
        }
        const columns = 'id, device_id, timestamp, payload, pricing_snapshot';
        type StoredRow = {
          id: string;
          device_id: string;
          timestamp: string;
          payload: string;
          pricing_snapshot: string;
        };
        const first = yield* sql.unsafe<StoredRow>(
          `SELECT ${columns} FROM usage_events WHERE ${ownerFilter}${window.length ? ` AND ${window.join(' AND ')}` : ''} ORDER BY timestamp`,
          [...parameters, ...windowParameters],
        );
        let rows = first;
        if (window.length) {
          if (copiedRevision !== ownerRevision) {
            const version = ownerRevision;
            const copies = yield* sql<{ id: string }>`SELECT id FROM usage_events GROUP BY id HAVING COUNT(*) > 1`;
            copiedIds = new Set(copies.map((row) => row.id));
            copiedRevision = version;
          }
          // Only copied IDs need out-of-window owners. Avoid a full-history ID
          // join and payload sort on the common path; include live local copies too.
          const candidates = new Set<string>();
          for (const row of first) if (copiedIds.has(row.id)) candidates.add(row.id);
          if (candidates.size) {
            const outside = yield* sql.unsafe<StoredRow>(
              `SELECT ${columns} FROM usage_events WHERE ${ownerFilter} AND id IN (SELECT value FROM json_each(?)) AND NOT (${window.join(' AND ')}) ORDER BY timestamp`,
              [...parameters, JSON.stringify([...candidates]), ...windowParameters],
            );
            if (outside.length) {
              const merged: StoredRow[] = [];
              let left = 0;
              let right = 0;
              while (left < first.length || right < outside.length) {
                if (
                  right >= outside.length ||
                  (left < first.length && first[left].timestamp <= outside[right].timestamp)
                )
                  merged.push(first[left++]);
                else merged.push(outside[right++]);
              }
              rows = merged;
            }
          }
        }
        const metadata = yield* sql<{ name: string; sources: string; pricing_updated_at: string }>`
        SELECT name, sources, pricing_updated_at FROM devices WHERE id <> ${excludeDeviceId ?? ''}
      `;
        const events: UsageEvent[] = [];
        for (let offset = 0; offset < rows.length; offset += 1_000) {
          yield* Effect.try({
            try: () => {
              for (const row of rows.slice(offset, offset + 1_000)) events.push(decodeEvent(row.payload));
            },
            catch: storageFailure,
          });
          yield* Effect.yieldNow;
        }
        const sources = yield* Effect.try({
          try: () =>
            metadata.flatMap((row) =>
              decodeSources(row.sources).map((source) => ({ ...source, path: `${row.name} · ${source.path}` })),
            ),
          catch: storageFailure,
        });
        return {
          events,
          sources,
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
      (effect, _excludeDeviceId?: string, _options: UsageReadOptions = {}) => Effect.mapError(effect, storageFailure),
    );

    const decodeWindowKey = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          excluded: Schema.String,
          revision: Schema.Number,
          options: Schema.Struct({
            start: Schema.optionalKey(Schema.String),
            end: Schema.optionalKey(Schema.String),
            devices: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        }),
      ),
    );
    const windows = yield* Cache.makeWith(
      (key: string) => {
        const input = decodeWindowKey(key);
        return readWindow(input.excluded, input.options);
      },
      { capacity: 2, timeToLive: (exit) => (Exit.isSuccess(exit) ? '5 minutes' : 0) },
    );
    const getUsage = Effect.fn('UsageStore.getUsage')(function* (
      excludeDeviceId?: string,
      options: UsageReadOptions = {},
    ) {
      const { candidateIds, ...windowOptions } = options;
      const data = yield* Cache.get(
        windows,
        JSON.stringify({ excluded: excludeDeviceId ?? '', revision, options: windowOptions }),
      );
      let events = data.events;
      let pricingSnapshots = data.pricingSnapshots;
      if (candidateIds?.length && (options.start || options.end)) {
        const owner = ['device_id <> ?'];
        const parameters: string[] = [excludeDeviceId ?? ''];
        if (options.devices) {
          owner.push(options.devices.length ? `device_id IN (${options.devices.map(() => '?').join(', ')})` : '0');
          parameters.push(...options.devices);
        }
        const time = [];
        const timeParameters: string[] = [];
        if (options.start) {
          time.push('timestamp >= ?');
          timeParameters.push(options.start);
        }
        if (options.end) {
          time.push('timestamp < ?');
          timeParameters.push(options.end);
        }
        const rows = yield* sql
          .unsafe<{ id: string; device_id: string; payload: string; pricing_snapshot: string }>(
            `SELECT id, device_id, payload, pricing_snapshot FROM usage_events WHERE ${owner.join(' AND ')} AND id IN (SELECT value FROM json_each(?)) AND NOT (${time.join(' AND ')}) ORDER BY timestamp`,
            [...parameters, JSON.stringify(candidateIds), ...timeParameters],
          )
          .pipe(Effect.mapError(storageFailure));
        if (rows.length) {
          const known = new Set(events.map((event) => `${event.deviceId}:${event.id}`));
          const extra: UsageEvent[] = [];
          const extraSnapshots: typeof pricingSnapshots = [];
          yield* Effect.try({
            try: () => {
              for (const row of rows) {
                if (known.has(`${row.device_id}:${row.id}`)) continue;
                extra.push(decodeEvent(row.payload));
                extraSnapshots.push({ eventId: row.id, deviceId: row.device_id, updatedAt: row.pricing_snapshot });
              }
            },
            catch: storageFailure,
          });
          if (extra.length) {
            // The common path retains the cached array. Exceptional live local
            // copies are merged in timestamp order to preserve winner selection.
            events = [...events, ...extra].sort(
              (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
            );
            pricingSnapshots = [...pricingSnapshots, ...extraSnapshots];
          }
        }
      }
      const metadata = yield* sql<{
        name: string;
        sources: string;
        pricing_updated_at: string;
      }>`SELECT name, sources, pricing_updated_at FROM devices WHERE id <> ${excludeDeviceId ?? ''}`.pipe(
        Effect.mapError(storageFailure),
      );
      const sources = yield* Effect.try({
        try: () =>
          metadata.flatMap((row) =>
            decodeSources(row.sources).map((source) => ({ ...source, path: `${row.name} · ${source.path}` })),
          ),
        catch: storageFailure,
      });
      return {
        ...data,
        events,
        pricingSnapshots,
        sources,
        pricingUpdatedAt:
          metadata
            .map((row) => row.pricing_updated_at)
            .sort()
            .at(-1) ?? '',
      };
    });

    const getDimensions = Effect.fn('UsageStore.getDimensions')(function* (excludeDeviceId?: string) {
      const rows =
        yield* sql`SELECT device_id AS deviceId, harness, model, project FROM usage_dimensions WHERE device_id <> ${excludeDeviceId ?? ''}`.pipe(
          Effect.mapError(storageFailure),
        );
      return yield* Effect.try({ try: () => decodeDimensions(rows), catch: storageFailure });
    });

    const authorizePricing = (secret: string) =>
      equalSecret(secret, configuration.pairingSecret)
        ? Effect.void
        : Effect.fail(new Unauthorized({ message: 'Pricing changes require the dashboard or its pairing secret.' }));
    return {
      getDevices,
      registerDevice,
      syncUsage,
      getUsage,
      getDimensions,
      getRevision: () => revision,
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
