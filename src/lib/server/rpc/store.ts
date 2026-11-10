import { Cache, Context, Effect, Exit, Schema, type Scope } from 'effect';
import { SqlClient } from 'effect/sql';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Device,
  Harness,
  SourceStatus,
  UsageEvent,
  type DeviceRegistration,
  type SessionMetadata,
  type SyncBatch,
} from '../../shared/domain';
import type { DayPacks } from './day-packs';
import { makePricingCandidates, pricingShapeIndex } from './pricing-candidates';
import { InvalidRequest, StorageFailure, Unauthorized } from '../../shared/rpc';
import {
  makeWindowPages,
  ownerFilter,
  priceStamp,
  rowColumns,
  utcDay,
  type StoredRow,
  type EventWindow,
  type UsageReadOptions,
} from './window-pages';
export type { UsageReadOptions } from './window-pages';

const storageFailure = () => new StorageFailure({ message: 'Could not access the dashboard’s usage database.' });
const revokedFailure = () =>
  new Unauthorized({
    message: 'This device is revoked. Restore it in the dashboard’s device settings, then connect it again.',
  });
const StoredDevice = Schema.Struct({
  ...Device.fields,
  collectorVersion: Schema.String,
  needsReconnect: Schema.BooleanFromBit,
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equalSecret = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
// Durable Object SQLite accepts at most 100 bound parameters per statement.
// Bulk ID lists travel as one JSON parameter; upserts bind six values per row.
const rowsPerUpsert = 16;

// The store runs on any Effect SqlClient with SQLite semantics: bun:sqlite on a
// self-hosted hub, or the Cloudflare hub's Durable Object storage.
export class ServerConfiguration extends Context.Service<
  ServerConfiguration,
  {
    readonly pairingSecret: string;
    readonly indexedPricing?: boolean;
    readonly openDayPacks?: Effect.Effect<DayPacks | undefined, never, Scope.Scope>;
  }
>()('token-tracker/ServerConfiguration') {}

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
  if (device.collectorVersion !== undefined && device.collectorVersion.length > 64) {
    return Effect.fail(new InvalidRequest({ message: 'A collector version must be at most 64 characters.' }));
  }
  return Effect.void;
};

const decodeEventObject = Schema.decodeUnknownSync(UsageEvent);
const sourcesJson = Schema.fromJsonString(Schema.Array(SourceStatus));
// Validate and strip unknown keys exactly as on the wire, without running a
// second generic schema transformation for every stored JSON string.
const decodeEvent = (payload: string) => decodeEventObject(JSON.parse(payload));
const decodeSources = Schema.decodeUnknownSync(sourcesJson);
// Optional metadata can disappear temporarily when a collector cannot read
// T3's database. Absence means unknown, rather than a request to erase it.
const preserveSessionMetadata = (incoming: UsageEvent, previous?: SessionMetadata) => ({
  sessionTitle: incoming.sessionTitle ?? previous?.sessionTitle,
  projectName: incoming.projectName ?? previous?.projectName,
  t3ThreadId:
    incoming.t3ThreadId ??
    (incoming.t3ThreadUrl === undefined || incoming.t3ThreadUrl === previous?.t3ThreadUrl
      ? previous?.t3ThreadId
      : undefined),
  t3ThreadUrl:
    incoming.t3ThreadUrl ??
    (incoming.t3ThreadId === undefined || incoming.t3ThreadId === previous?.t3ThreadId
      ? previous?.t3ThreadUrl
      : undefined),
});
const preserveRepository = (incoming: UsageEvent, previous?: UsageEvent) =>
  previous?.t3ThreadId &&
  previous.repository &&
  !previous.repository.startsWith('local:') &&
  incoming.t3ThreadId === undefined &&
  incoming.t3ThreadUrl === undefined &&
  incoming.project === previous.project &&
  incoming.harness === previous.harness &&
  incoming.sessionId === previous.sessionId &&
  (!incoming.repository || incoming.repository.startsWith('local:'))
    ? previous.repository
    : incoming.repository;
const UsageDimension = Schema.Struct({
  deviceId: Schema.String,
  harness: Harness,
  model: Schema.String,
  project: Schema.String,
});
const decodeDimensions = Schema.decodeUnknownSync(Schema.Array(UsageDimension));
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
      sources TEXT NOT NULL DEFAULT '[]', pricing_updated_at TEXT NOT NULL DEFAULT '', revoked_at TEXT,
      collector_version TEXT NOT NULL DEFAULT ''
    )`)
      .pipe(Effect.mapError(storageFailure));
    const deviceColumns = yield* sql
      .unsafe<{ name: string }>('PRAGMA table_info(devices)')
      .pipe(Effect.mapError(storageFailure));
    if (!deviceColumns.some((column) => column.name === 'revoked_at')) {
      yield* sql.unsafe('ALTER TABLE devices ADD COLUMN revoked_at TEXT').pipe(Effect.mapError(storageFailure));
    }
    if (!deviceColumns.some((column) => column.name === 'collector_version')) {
      yield* sql
        .unsafe("ALTER TABLE devices ADD COLUMN collector_version TEXT NOT NULL DEFAULT ''")
        .pipe(Effect.mapError(storageFailure));
    }
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
      .unsafe('CREATE INDEX IF NOT EXISTS usage_events_device_timestamp ON usage_events(device_id, timestamp)')
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
    // Copies with the same normalized timestamp are either all in the window or
    // all outside it. Only divergent copies can change ownership across an edge.
    // Keep that much smaller set transactionally, including timestamp corrections.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('usage_cross_window_ids', 'usage_copied_ids')`;
          if (!existing.some((row) => row.name === 'usage_cross_window_ids')) {
            yield* sql.unsafe('CREATE TABLE usage_cross_window_ids (id TEXT PRIMARY KEY) WITHOUT ROWID');
            const hasLegacy = existing.some((row) => row.name === 'usage_copied_ids');
            const copies = hasLegacy
              ? 'usage_copied_ids'
              : '(SELECT id FROM usage_events GROUP BY id HAVING COUNT(*) > 1)';
            yield* sql.unsafe(`INSERT INTO usage_cross_window_ids
          SELECT c.id FROM ${copies} c WHERE EXISTS (SELECT 1 FROM usage_events e
            WHERE e.id = c.id AND e.timestamp <> (SELECT timestamp FROM usage_events WHERE id = c.id LIMIT 1))`);
          }
          // The previous binary can recreate its own helper on a rollback. Avoid
          // maintaining both derived indexes on every subsequent collector write.
          if (existing.some((row) => row.name === 'usage_copied_ids')) {
            for (const trigger of ['insert', 'delete', 'update'])
              yield* sql.unsafe(`DROP TRIGGER IF EXISTS usage_copied_ids_${trigger}`);
            yield* sql.unsafe('DROP TABLE usage_copied_ids');
          }
          const add = `INSERT OR IGNORE INTO usage_cross_window_ids SELECT NEW.id WHERE EXISTS (
        SELECT 1 FROM usage_events WHERE id = NEW.id AND timestamp <> NEW.timestamp);`;
          const remove = `DELETE FROM usage_cross_window_ids WHERE id = OLD.id AND NOT EXISTS (
        SELECT 1 FROM usage_events WHERE id = OLD.id AND timestamp <> (SELECT timestamp FROM usage_events WHERE id = OLD.id LIMIT 1));`;
          yield* sql.unsafe(
            `CREATE TRIGGER IF NOT EXISTS usage_cross_window_ids_insert AFTER INSERT ON usage_events BEGIN ${add} END`,
          );
          yield* sql.unsafe(
            `CREATE TRIGGER IF NOT EXISTS usage_cross_window_ids_delete AFTER DELETE ON usage_events BEGIN ${remove} END`,
          );
          yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS usage_cross_window_ids_update AFTER UPDATE OF id, timestamp ON usage_events
        WHEN OLD.id IS NOT NEW.id OR OLD.timestamp IS NOT NEW.timestamp BEGIN ${remove} ${add} END`);
        }),
      )
      .pipe(Effect.mapError(storageFailure));
    // Self-hosted SQLite can build this disk index once. Keep Durable Object
    // migrations within their CPU budget and retain the portable scan there.
    if (configuration.indexedPricing) yield* sql.unsafe(pricingShapeIndex).pipe(Effect.mapError(storageFailure));
    const pricingCandidates = makePricingCandidates(sql, decodeEvent);
    const getPricingCandidates = (...args: Parameters<typeof pricingCandidates>) =>
      configuration.indexedPricing
        ? pricingCandidates(...args).pipe(
            Effect.catchDefect(() => Effect.fail(storageFailure())),
            Effect.mapError(storageFailure),
          )
        : Effect.succeed(undefined);
    let revision = 0;
    let metadataRevision = 0;
    const packs = configuration.openDayPacks ? yield* configuration.openDayPacks : undefined;
    const pages = makeWindowPages(sql, decodeEvent, () => revision, storageFailure, packs);
    let copiedRevision = -1;
    let copiedIds = new Set<string>();
    // Upload work remains cancellable, but a durable commit must publish its
    // generation before cancellation can discard the acknowledgement.
    const commitWrite = <A, E, R>(write: Effect.Effect<A, E, R>, onCommit: (result: A) => void) =>
      Effect.uninterruptibleMask((restore) =>
        sql.withTransaction(restore(write)).pipe(Effect.tap((result) => Effect.sync(() => onCommit(result)))),
      );

    const getDevices = Effect.fn('UsageStore.getDevices')(
      function* () {
        const rows = yield* sql`
        SELECT d.id, d.name, d.platform, d.last_seen AS lastSeen, d.revoked_at AS revokedAt,
          d.collector_version AS collectorVersion, d.token_hash = '' AS needsReconnect,
          COALESCE((SELECT SUM(records) FROM usage_dimensions e WHERE e.device_id = d.id), 0) AS eventCount
        FROM devices d ORDER BY d.name
      `;
        const devices = yield* Schema.decodeUnknownEffect(Schema.Array(StoredDevice))(rows);
        // Devices whose collectors never reported a version omit the field.
        return devices.map(({ collectorVersion, ...device }): Device =>
          collectorVersion ? { ...device, collectorVersion } : device,
        );
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
      const collectorVersion = device.collectorVersion?.trim() ?? '';
      // A revoked device stays blocked, even with the pairing secret, until the
      // dashboard restores it. The conflict update skips it atomically.
      yield* commitWrite(
        Effect.gen(function* () {
          const previous = yield* sql<{
            name: string;
            platform: string;
          }>`SELECT name, platform FROM devices WHERE id = ${device.id}`;
          const paired = yield* sql<{ id: string }>`
              INSERT INTO devices (id, name, platform, token_hash, collector_version)
              VALUES (${device.id}, ${device.name}, ${device.platform}, ${digest(token)}, ${collectorVersion})
              ON CONFLICT (id) DO UPDATE SET name = excluded.name,
                platform = excluded.platform, token_hash = excluded.token_hash,
                collector_version = COALESCE(NULLIF(excluded.collector_version, ''), devices.collector_version)
              WHERE devices.revoked_at IS NULL
              RETURNING id
            `;
          if (!paired.length) return yield* Effect.fail(revokedFailure());
          return previous[0]?.name !== device.name || previous[0]?.platform !== device.platform;
        }),
        (metadataChanged) => {
          if (metadataChanged) metadataRevision++;
        },
      ).pipe(Effect.catchTag('SqlError', () => Effect.fail(storageFailure())));
      const devices = yield* getDevices();
      const registered = devices.find((item) => item.id === device.id);
      if (!registered) return yield* Effect.fail(storageFailure());
      return { device: registered, token };
    });

    const writeUsageBatch = Effect.fn('UsageStore.writeUsageBatch')(function* (
      deviceId: string,
      batch: SyncBatch,
      authorization: { token: string } | { pairingSecret: string },
    ) {
      yield* validateDevice(batch.device);
      if (batch.device.id !== deviceId)
        return yield* Effect.fail(new InvalidRequest({ message: 'The sync batch belongs to a different device.' }));
      if (batch.events.length + (batch.deletedIds?.length ?? 0) > 10_000) {
        return yield* Effect.fail(new InvalidRequest({ message: 'A sync batch can contain at most 10,000 records.' }));
      }
      if ('pairingSecret' in authorization && batch.deletedIds?.length)
        return yield* Effect.fail(new InvalidRequest({ message: 'Migration imports cannot delete usage records.' }));
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
      const result = yield* commitWrite(
        Effect.gen(function* () {
          let createdDevice = false;
          if ('pairingSecret' in authorization) {
            if (!equalSecret(authorization.pairingSecret, configuration.pairingSecret))
              return yield* Effect.fail(new Unauthorized({ message: 'The pairing secret is incorrect.' }));
            // Migration may create devices, but never rotates a connected
            // collector's credential. New devices still pair normally later.
            const inserted = yield* sql`INSERT INTO devices (id, name, platform, token_hash)
                VALUES (${deviceId}, ${batch.device.name}, ${batch.device.platform}, ${digest(randomBytes(32).toString('base64url'))})
                ON CONFLICT (id) DO NOTHING RETURNING id`;
            createdDevice = inserted.length > 0;
          }
          const credentials = yield* sql<{
            token_hash: string;
            revoked_at: string | null;
            platform: string;
            sources: string;
            pricing_updated_at: string;
          }>`SELECT token_hash, revoked_at, platform, sources, pricing_updated_at FROM devices WHERE id = ${deviceId}`;
          const previousDevice = credentials[0];
          if (previousDevice?.revoked_at) return yield* Effect.fail(revokedFailure());
          if ('token' in authorization) {
            if (!previousDevice || !equalSecret(digest(authorization.token), previousDevice.token_hash)) {
              return yield* Effect.fail(
                new Unauthorized({
                  message: 'This device is not connected, or its credential has expired. Connect it again.',
                }),
              );
            }
          }
          let accepted = 0;
          let updated = 0;
          let deleted = 0;
          const changedDays = new Set<string>();
          const pricingSnapshot = batch.pricingUpdatedAt?.trim() ?? '';
          const existingRows = batch.events.length
            ? yield* sql.unsafe<{ id: string; timestamp: string; payload_hash: string; payload: string }>(
                'SELECT id, timestamp, payload_hash, payload FROM usage_events WHERE device_id = ? AND id IN (SELECT value FROM json_each(?))',
                [deviceId, JSON.stringify(batch.events.map((event) => event.id))],
              )
            : [];
          const existing = yield* Effect.try({
            try: () =>
              new Map(
                existingRows.map((row) => [
                  row.id,
                  { hash: row.payload_hash, timestamp: row.timestamp, event: decodeEvent(row.payload) },
                ]),
              ),
            catch: storageFailure,
          });
          const changedRows: {
            device_id: string;
            id: string;
            timestamp: string;
            payload: string;
            payload_hash: string;
            pricing_snapshot: string;
          }[] = [];
          for (const event of batch.events) {
            const previous = existing.get(event.id);
            // A source backup can be older than corrections already synced
            // by collectors. Imports only fill missing record IDs.
            if (previous && 'pairingSecret' in authorization) continue;
            const normalized = {
              ...preserveSessionMetadata(event, previous?.event),
              ...event,
              // A missing optional T3 binding is not evidence that an attached
              // remote was removed. Explicit bindings and cwd remotes still win.
              repository: preserveRepository(event, previous?.event),
              deviceId,
              costUsd: event.costKnown ? event.costUsd : 0,
            };
            const payload = JSON.stringify(normalized);
            const payloadHash = digest(JSON.stringify([pricingSnapshot, payload]));
            if (previous?.hash === payloadHash) continue;
            const timestamp = new Date(event.timestamp).toISOString();
            changedDays.add(utcDay(timestamp));
            if (previous) changedDays.add(utcDay(previous.timestamp));
            changedRows.push({
              device_id: deviceId,
              id: event.id,
              timestamp,
              payload,
              payload_hash: payloadHash,
              pricing_snapshot: pricingSnapshot,
            });
            if (previous === undefined) accepted += 1;
            else updated += 1;
            existing.set(event.id, { hash: payloadHash, timestamp, event: normalized });
          }
          for (let offset = 0; offset < changedRows.length; offset += rowsPerUpsert) {
            const chunk = changedRows.slice(offset, offset + rowsPerUpsert);
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
            const rows = yield* sql.unsafe<{ timestamp: string }>(
              'DELETE FROM usage_events WHERE device_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING timestamp',
              [deviceId, JSON.stringify(ids)],
            );
            deleted += rows.length;
            for (const { timestamp } of rows) changedDays.add(utcDay(timestamp));
          }
          const receivedAt = new Date().toISOString();
          const sources = batch.sources ? JSON.stringify(batch.sources) : null;
          const pricingUpdatedAt = batch.pricingUpdatedAt || null;
          const collectorVersion = batch.device.collectorVersion?.trim() || null;
          const metadataChanged =
            createdDevice ||
            previousDevice?.platform !== batch.device.platform ||
            (sources !== null && sources !== previousDevice?.sources) ||
            (pricingUpdatedAt !== null && pricingUpdatedAt !== previousDevice?.pricing_updated_at);
          // Pairing sets the name; later uploads keep any rename from the dashboard.
          yield* sql`UPDATE devices SET platform = ${batch.device.platform}, last_seen = ${receivedAt},
              sources = COALESCE(${sources}, sources),
              pricing_updated_at = COALESCE(${pricingUpdatedAt}, pricing_updated_at),
              collector_version = COALESCE(${collectorVersion}, collector_version) WHERE id = ${deviceId}`;
          return { accepted, updated, deleted, receivedAt, metadataChanged, changedDays };
        }),
        (result) => {
          if (result.changedDays.size) {
            revision++;
            pages.invalidate(result.changedDays);
          }
          if (result.metadataChanged) metadataRevision++;
        },
      ).pipe(Effect.catchTag('SqlError', () => Effect.fail(storageFailure())));
      const { metadataChanged: _metadataChanged, changedDays: _changedDays, ...acknowledgement } = result;
      return acknowledgement;
    });

    // Outside copies can change the selected owner even if their timestamps don't
    // match the range. Only merge/sort those exceptions, never re-sort the entire
    // decoded history just because a local log supplied another candidate ID.
    const readOutside = (excluded: string, options: UsageReadOptions, ids: readonly string[]) => {
      const owner = ownerFilter(excluded, options.devices);
      return sql
        .unsafe<StoredRow>(
          `SELECT ${rowColumns} FROM usage_events WHERE ${owner.where}
         AND id IN (SELECT value FROM json_each(?)) AND (timestamp < ? OR timestamp >= ?) ORDER BY timestamp`,
          [...owner.params, JSON.stringify(ids), options.start || '', options.end || '\uffff'],
        )
        .pipe(Effect.mapError(storageFailure));
    };
    type Outside = { event: UsageEvent; stamp: ReturnType<typeof priceStamp>; timestamp: string };
    const withOutside = (inside: EventWindow, outside: Outside[], end: string | undefined) => {
      if (!outside.length) return { ...inside, inside, outside };
      const events = outside.map((entry) => entry.event);
      const stamps = outside.map((entry) => entry.stamp);
      // Already sorted by the normalized UTC index. Outside copies either
      // precede the entire inside window or follow its exclusive upper bound.
      const index = end ? outside.findIndex((entry) => entry.timestamp >= end) : -1;
      const split = index < 0 ? outside.length : index;
      return {
        events: events.slice(0, split).concat(inside.events, events.slice(split)),
        pricingSnapshots: stamps.slice(0, split).concat(inside.pricingSnapshots, stamps.slice(split)),
        inside,
        outside,
      };
    };
    const decodeOutside = (rows: readonly StoredRow[]) =>
      Effect.try({
        try: () =>
          rows.map((row) => ({ event: decodeEvent(row.payload), timestamp: row.timestamp, stamp: priceStamp(row) })),
        catch: storageFailure,
      });
    const readWindow = Effect.fn('UsageStore.readWindow')(
      function* (excluded: string, options: UsageReadOptions = {}, allowFills = true) {
        const data = yield* pages.read(excluded, options, allowFills);
        if ((!options.start && !options.end) || !data.events.length || options.devices?.length === 1)
          return withOutside(data, [], options.end);
        if (copiedRevision !== revision) {
          const version = revision;
          const copies = yield* sql<{ id: string }>`SELECT id FROM usage_cross_window_ids`;
          copiedIds = new Set(copies.map((row) => row.id));
          copiedRevision = version;
        }
        const candidates = new Set<string>();
        if (copiedIds.size)
          for (const stamp of data.pricingSnapshots) if (copiedIds.has(stamp.eventId)) candidates.add(stamp.eventId);
        if (!candidates.size) return withOutside(data, [], options.end);
        return withOutside(
          data,
          yield* decodeOutside(yield* readOutside(excluded, options, [...candidates])),
          options.end,
        );
      },
      (effect) => Effect.mapError(effect, storageFailure),
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
      { capacity: 2, timeToLive: (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0) },
    );
    let windowRevision = revision;
    const metadataCache = yield* Cache.makeWith(
      (key: string) =>
        Effect.gen(function* () {
          const excluded = key.slice(key.indexOf(':') + 1);
          const metadata = yield* sql<{
            name: string;
            sources: string;
            pricing_updated_at: string;
          }>`SELECT name, sources, pricing_updated_at FROM devices WHERE id <> ${excluded}`.pipe(
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
            sources,
            pricingUpdatedAt:
              metadata
                .map((row) => row.pricing_updated_at)
                .sort()
                .at(-1) ?? '',
          };
        }),
      { capacity: 2, timeToLive: (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0) },
    );
    const readMetadata = (excluded = '') => Cache.get(metadataCache, `${metadataRevision}:${excluded}`);
    const getSources = (excluded?: string) => Effect.map(readMetadata(excluded), (metadata) => metadata.sources);
    const includeLocalOwners = Effect.fn('UsageStore.includeLocalOwners')(function* (
      data: ReturnType<typeof withOutside>,
      excluded: string,
      options: UsageReadOptions,
    ) {
      const { candidateIds } = options;
      if (candidateIds?.length && (options.start || options.end)) {
        const candidates = yield* readOutside(excluded, options, candidateIds);
        if (candidates.length) {
          const known = new Set(data.outside.map(({ stamp }) => JSON.stringify([stamp.deviceId, stamp.eventId])));
          const rows = known.size
            ? candidates.filter((row) => !known.has(JSON.stringify([row.device_id, row.id])))
            : candidates;
          if (rows.length) {
            const extra = yield* decodeOutside(rows);
            const outside = data.outside.length
              ? data.outside
                  .concat(extra)
                  .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
              : extra;
            data = withOutside(data.inside, outside, options.end);
          }
        }
      }
      return data;
    });
    const getUsage = Effect.fn('UsageStore.getUsage')(function* (
      excludeDeviceId?: string,
      options: UsageReadOptions = {},
    ) {
      const { candidateIds: _candidateIds, ...windowOptions } = options;
      // Retire large decoded arrays after a committed event change. Metadata
      // updates reuse them, and the revision in each key isolates in-flight reads.
      if (windowRevision !== revision) {
        yield* Cache.invalidateAll(windows);
        windowRevision = revision;
      }
      const generation = revision;
      const excluded = excludeDeviceId ?? '';
      const cached = yield* Cache.get(
        windows,
        JSON.stringify({ excluded, revision: generation, options: windowOptions }),
      );
      let data = yield* includeLocalOwners(cached, excluded, options);
      if (generation !== revision) {
        // A move, correction or deletion may land between date pages or owner
        // lookups. Retry once under one database transaction; do not await a
        // shared cache entry here (its producer could need the same connection).
        data = yield* sql
          .withTransaction(
            readWindow(excluded, options, false).pipe(
              Effect.flatMap((fresh) => includeLocalOwners(fresh, excluded, options)),
            ),
          )
          .pipe(Effect.mapError(storageFailure));
      }
      return {
        events: data.events,
        pricingSnapshots: data.pricingSnapshots,
        warnings: [],
        ...(yield* readMetadata(excludeDeviceId)),
      };
    });

    const getDimensions = Effect.fn('UsageStore.getDimensions')(function* (excludeDeviceId?: string) {
      const rows =
        yield* sql`SELECT device_id AS deviceId, harness, model, project FROM usage_dimensions WHERE device_id <> ${excludeDeviceId ?? ''}`.pipe(
          Effect.mapError(storageFailure),
        );
      return yield* Effect.try({ try: () => decodeDimensions(rows), catch: storageFailure });
    });

    const authorizeAdmin = (secret: string, action = 'Pricing changes') =>
      equalSecret(secret, configuration.pairingSecret)
        ? Effect.void
        : Effect.fail(new Unauthorized({ message: `${action} require the dashboard or its pairing secret.` }));
    const authorizeDevice = Effect.fn('UsageStore.authorizeDevice')(function* (deviceId: string, token: string) {
      const credentials = yield* sql<{
        token_hash: string;
      }>`SELECT token_hash FROM devices WHERE id = ${deviceId} AND revoked_at IS NULL`.pipe(
        Effect.mapError(storageFailure),
      );
      if (!credentials[0] || !equalSecret(digest(token), credentials[0].token_hash))
        return yield* new Unauthorized({ message: 'A connected device credential is required.' });
    });
    const deviceById = Effect.fn('UsageStore.deviceById')(function* (deviceId: string) {
      const device = (yield* getDevices()).find((item) => item.id === deviceId);
      if (!device)
        return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
      return device;
    });
    // Renaming and revoking only change the device row. Usage history stays.
    const renameDevice = Effect.fn('UsageStore.renameDevice')(function* (deviceId: string, name: string) {
      const label = name.trim();
      if (!label || label.length > 200)
        return yield* new InvalidRequest({ message: 'Enter a device name of at most 200 characters.' });
      yield* commitWrite(
        Effect.gen(function* () {
          const previous = yield* sql<{
            name: string;
          }>`SELECT name FROM devices WHERE id = ${deviceId} AND revoked_at IS NULL`;
          if (!previous[0])
            return yield* new InvalidRequest({
              message: 'Only connected devices that are not revoked can be renamed.',
            });
          yield* sql`UPDATE devices SET name = ${label} WHERE id = ${deviceId}`;
          return previous[0].name !== label;
        }),
        (metadataChanged) => {
          if (metadataChanged) metadataRevision++;
        },
      ).pipe(Effect.catchTag('SqlError', () => Effect.fail(storageFailure())));
      return yield* deviceById(deviceId);
    });
    const revokeDevice = Effect.fn('UsageStore.revokeDevice')(function* (deviceId: string) {
      // Clearing the hash also invalidates the token; a digest never equals ''.
      const revoked = yield* sql<{
        id: string;
      }>`UPDATE devices SET revoked_at = COALESCE(revoked_at, ${new Date().toISOString()}), token_hash = ''
        WHERE id = ${deviceId} RETURNING id`.pipe(Effect.mapError(storageFailure));
      if (!revoked.length)
        return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
      return yield* deviceById(deviceId);
    });
    // Restoring only lifts the block. The old token stays discarded, so the
    // device must pair again for a new one. Restoring an unrevoked device is a no-op.
    const restoreDevice = Effect.fn('UsageStore.restoreDevice')(function* (deviceId: string) {
      const restored = yield* sql<{
        id: string;
      }>`UPDATE devices SET revoked_at = NULL WHERE id = ${deviceId} RETURNING id`.pipe(
        Effect.mapError(storageFailure),
      );
      if (!restored.length)
        return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
      return yield* deviceById(deviceId);
    });
    return {
      getDevices,
      registerDevice,
      renameDevice,
      revokeDevice,
      restoreDevice,
      syncUsage: (deviceId: string, token: string, batch: SyncBatch) => writeUsageBatch(deviceId, batch, { token }),
      importUsage: (pairingSecret: string, batch: SyncBatch) =>
        writeUsageBatch(batch.device.id, batch, { pairingSecret }),
      getUsage,
      getSources,
      getDimensions,
      getPricingCandidates,
      getRevision: () => revision,
      getMetadataRevision: () => metadataRevision,
      authorizeAdmin,
      authorizeDevice,
    };
  }),
}) {}
