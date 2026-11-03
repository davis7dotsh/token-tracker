import { Cache, Effect, Exit, Layer, Schema, Semaphore } from 'effect';
import { randomBytes } from 'node:crypto';
import { type DeviceRegistration, type SyncBatch, type UsageEvent } from '../../shared/domain';
import { InvalidRequest, Unauthorized } from '../../shared/rpc';
import {
  makeClickHouseClient,
  text,
  type ClickHouseConfig,
  type ClickHouseParam,
  type ClickHouseRow,
} from './clickhouse';
import {
  eventColumns,
  eventToRow,
  formatTimestamp,
  latestEvents,
  nextVersion,
  parseTimestamp,
  rowToEvent,
  schemaStatements,
} from './clickhouse-schema';
import {
  StoredDevice,
  UsageStore,
  decodeDimensions,
  decodeSources,
  digest,
  equalSecret,
  preserveRepository,
  preserveSessionMetadata,
  revokedFailure,
  storageFailure,
  validateDevice,
  type UsageReadOptions,
} from './store';

// EXPERIMENTAL: the UsageStore contract on ClickHouse for a self-hosted Bun hub.
// Writes append versioned rows instead of updating in place (see
// clickhouse-schema.ts). Unlike SQLite there are no transactions: a failed batch
// may be partially written, and a retried batch converges because unchanged
// records are skipped by payload hash. Device changes are read-modify-write, so
// one in-process lock serializes them; a single hub process owns the database.
const idsPerQuery = 1_000;
const chunks = <A>(items: readonly A[], size = idsPerQuery) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const present = (value: unknown) => value !== null && value !== undefined;
const deviceColumns = 'id, name, platform, token_hash, last_seen, sources, pricing_updated_at, revoked_at';
const deviceState = (row: ClickHouseRow) => ({
  id: text(row.id),
  name: text(row.name),
  platform: text(row.platform),
  token_hash: text(row.token_hash),
  last_seen: present(row.last_seen) ? parseTimestamp(text(row.last_seen)) : null,
  sources: text(row.sources),
  pricing_updated_at: text(row.pricing_updated_at),
  revoked_at: present(row.revoked_at) ? parseTimestamp(text(row.revoked_at)) : null,
});
type DeviceState = ReturnType<typeof deviceState>;
const byTimestamp = (left: ClickHouseRow, right: ClickHouseRow) => {
  const [a, b] = [text(left.timestamp), text(right.timestamp)];
  return a < b ? -1 : a > b ? 1 : 0;
};
const ownerFilter = (excludeDeviceId: string | undefined, devices: readonly string[] | undefined) => ({
  where: [
    'device_id != {excluded:String}',
    ...(devices ? [devices.length ? 'device_id IN {devices:Array(String)}' : '0'] : []),
  ].join(' AND '),
  params: { excluded: excludeDeviceId ?? '', ...(devices?.length ? { devices } : {}) },
});
const timeFilter = (options: UsageReadOptions) => ({
  where: [
    ...(options.start ? ["timestamp >= {start:DateTime64(3, 'UTC')}"] : []),
    ...(options.end ? ["timestamp < {end:DateTime64(3, 'UTC')}"] : []),
  ].join(' AND '),
  params: {
    ...(options.start ? { start: formatTimestamp(options.start) } : {}),
    ...(options.end ? { end: formatTimestamp(options.end) } : {}),
  },
});

export const makeClickHouseUsageStore = (config: ClickHouseConfig, pairingSecret: string) =>
  Effect.gen(function* () {
    const client = yield* Effect.try({ try: () => makeClickHouseClient(config), catch: storageFailure });
    const attempt = <A>(evaluate: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(
        Effect.tapError((cause) => Effect.logError('ClickHouse request failed', cause)),
        Effect.mapError(storageFailure),
      );
    const query = (sql: string, params: Record<string, ClickHouseParam> = {}) =>
      attempt((signal) => client.query(sql, params, signal));
    const insert = (table: string, rows: readonly ClickHouseRow[]) =>
      attempt((signal) => client.insert(table, rows, signal));

    // The DDL is the schema's single source of truth; every statement is idempotent.
    for (const statement of schemaStatements(client.database))
      yield* attempt((signal) => client.command(statement, { database: 'default', signal }));

    let revision = 0;
    let ownerRevision = 0;
    // Set when a batch failed after inserts were attempted: the server may
    // still commit them after the client gave up, so reads bypass the window
    // cache until this passes rather than freezing a pre-commit snapshot.
    let uncertainWritesUntil = 0;
    let copiedRevision = -1;
    let copiedIds = new Set<string>();
    // Every device read-modify-write and credential check runs under this lock,
    // so a concurrent rename or sync cannot write back a pre-revocation row.
    const exclusive = (yield* Semaphore.make(1)).withPermits(1);

    const readDevice = (deviceId: string) =>
      query(`SELECT ${deviceColumns} FROM devices FINAL WHERE id = {id:String}`, { id: deviceId }).pipe(
        Effect.map((rows) => (rows[0] ? deviceState(rows[0]) : undefined)),
      );
    // A device change appends a superseding row; FINAL reads the latest one.
    const writeDevice = (device: DeviceState) =>
      insert('devices', [
        {
          ...device,
          last_seen: device.last_seen && formatTimestamp(device.last_seen),
          revoked_at: device.revoked_at && formatTimestamp(device.revoked_at),
          version: nextVersion(),
        },
      ]);
    // Latest live versions of the given record IDs, sorted by timestamp.
    const latestByIds = Effect.fn('ClickHouseUsageStore.latestByIds')(function* (
      ids: readonly string[],
      owner: { where: string; params: Record<string, ClickHouseParam> },
      outside?: { where: string; params: Record<string, ClickHouseParam> },
    ) {
      const pages = yield* Effect.forEach(chunks([...new Set(ids)]), (chunk) =>
        query(
          `SELECT * FROM (${latestEvents(eventColumns, `${owner.where} AND id IN {ids:Array(String)}`)})
          WHERE is_deleted = 0${outside ? ` AND NOT (${outside.where})` : ''}`,
          { ...owner.params, ...outside?.params, ids: chunk },
        ),
      );
      return pages.flat().sort(byTimestamp);
    });
    const readMetadata = Effect.fn('ClickHouseUsageStore.readMetadata')(function* (excludeDeviceId?: string) {
      const metadata = yield* query(
        'SELECT name, sources, pricing_updated_at FROM devices FINAL WHERE id != {excluded:String}',
        { excluded: excludeDeviceId ?? '' },
      );
      const sources = yield* Effect.try({
        try: () =>
          metadata.flatMap((row) =>
            decodeSources(row.sources).map((source) => ({ ...source, path: `${text(row.name)} · ${source.path}` })),
          ),
        catch: storageFailure,
      });
      return {
        sources,
        pricingUpdatedAt:
          metadata
            .map((row) => text(row.pricing_updated_at))
            .sort()
            .at(-1) ?? '',
      };
    });
    const decodeRows = Effect.fn('ClickHouseUsageStore.decodeRows')(function* (rows: readonly ClickHouseRow[]) {
      const events: UsageEvent[] = [];
      for (const chunk of chunks(rows)) {
        yield* Effect.try({
          try: () => {
            for (const row of chunk) events.push(rowToEvent(row));
          },
          catch: storageFailure,
        });
        yield* Effect.yieldNow;
      }
      return events;
    });
    const snapshotsOf = (rows: readonly ClickHouseRow[]) =>
      rows.map((row) => ({
        eventId: text(row.id),
        deviceId: text(row.device_id),
        updatedAt: text(row.pricing_snapshot),
      }));

    const getDevices = Effect.fn('ClickHouseUsageStore.getDevices')(
      function* () {
        const [rows, counts] = yield* Effect.all(
          [
            query(`SELECT ${deviceColumns} FROM devices FINAL ORDER BY name`),
            query(
              `SELECT device_id, count() AS records FROM (${latestEvents(['is_deleted'])})
              WHERE is_deleted = 0 GROUP BY device_id`,
            ),
          ],
          { concurrency: 2 },
        );
        const records = new Map(counts.map((row) => [text(row.device_id), Number(row.records)]));
        return yield* Schema.decodeUnknownEffect(Schema.Array(StoredDevice))(
          rows.map(deviceState).map((device) => ({
            id: device.id,
            name: device.name,
            platform: device.platform,
            lastSeen: device.last_seen,
            revokedAt: device.revoked_at,
            needsReconnect: device.token_hash === '' ? 1 : 0,
            eventCount: records.get(device.id) ?? 0,
          })),
        );
      },
      (effect) => Effect.mapError(effect, storageFailure),
    );

    const registerDevice = Effect.fn('ClickHouseUsageStore.registerDevice')(function* (
      secret: string,
      device: DeviceRegistration,
    ) {
      if (!equalSecret(secret, pairingSecret)) {
        return yield* Effect.fail(new Unauthorized({ message: 'The pairing secret is incorrect.' }));
      }
      yield* validateDevice(device);
      const token = randomBytes(32).toString('base64url');
      // A revoked device stays blocked, even with the pairing secret, until the
      // dashboard restores it.
      yield* exclusive(
        Effect.gen(function* () {
          const current = yield* readDevice(device.id);
          if (current?.revoked_at) return yield* Effect.fail(revokedFailure());
          yield* writeDevice({
            last_seen: null,
            sources: '[]',
            pricing_updated_at: '',
            revoked_at: null,
            ...current,
            id: device.id,
            name: device.name,
            platform: device.platform,
            token_hash: digest(token),
          });
        }),
      );
      const devices = yield* getDevices();
      const registered = devices.find((item) => item.id === device.id);
      if (!registered) return yield* Effect.fail(storageFailure());
      revision++;
      return { device: registered, token };
    });

    const writeUsageBatch = Effect.fn('ClickHouseUsageStore.writeUsageBatch')(function* (
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

      yield* exclusive(
        Effect.gen(function* () {
          if ('pairingSecret' in authorization) {
            if (!equalSecret(authorization.pairingSecret, pairingSecret))
              return yield* Effect.fail(new Unauthorized({ message: 'The pairing secret is incorrect.' }));
            // Migration may create devices, but never rotates a connected
            // collector's credential. New devices still pair normally later.
            const target = yield* readDevice(deviceId);
            if (target?.revoked_at) return yield* Effect.fail(revokedFailure());
            if (!target)
              yield* writeDevice({
                id: deviceId,
                name: batch.device.name,
                platform: batch.device.platform,
                token_hash: digest(randomBytes(32).toString('base64url')),
                last_seen: null,
                sources: '[]',
                pricing_updated_at: '',
                revoked_at: null,
              });
          } else {
            const credentials = yield* readDevice(deviceId);
            if (credentials?.revoked_at) return yield* Effect.fail(revokedFailure());
            if (!credentials || !equalSecret(digest(authorization.token), credentials.token_hash)) {
              return yield* Effect.fail(
                new Unauthorized({
                  message: 'This device is not connected, or its credential has expired. Connect it again.',
                }),
              );
            }
          }
        }),
      );
      // A batch that fails or is interrupted after an insert may still have
      // written part of it, and its retry then finds those records unchanged.
      // Count any attempted insert as a change so cached windows cannot hide it.
      const written = { events: false, owners: false };
      return yield* Effect.gen(function* () {
        let accepted = 0;
        let updated = 0;
        let deleted = 0;
        const pricingSnapshot = batch.pricingUpdatedAt?.trim() ?? '';
        const owner = { where: 'device_id = {device:String}', params: { device: deviceId } };
        const existingRows = yield* latestByIds(
          batch.events.map((event) => event.id),
          owner,
        );
        const existing = yield* Effect.try({
          try: () =>
            new Map(
              existingRows.map((row) => [text(row.id), { hash: text(row.payload_hash), event: rowToEvent(row) }]),
            ),
          catch: storageFailure,
        });
        const changedRows: ClickHouseRow[] = [];
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
          // Hash the same JSON payload as SQLite so migrated records stay unchanged.
          const payloadHash = digest(JSON.stringify([pricingSnapshot, JSON.stringify(normalized)]));
          if (previous?.hash === payloadHash) continue;
          changedRows.push(eventToRow(normalized, deviceId, nextVersion(), pricingSnapshot, payloadHash));
          if (previous === undefined) accepted += 1;
          else updated += 1;
          existing.set(event.id, { hash: payloadHash, event: normalized });
        }
        written.events ||= changedRows.length > 0;
        written.owners ||= accepted > 0;
        yield* insert('usage_events', changedRows);
        // Deletion appends a tombstone version of each live record.
        const doomed = yield* latestByIds(batch.deletedIds ?? [], owner);
        written.events ||= doomed.length > 0;
        written.owners ||= doomed.length > 0;
        yield* insert(
          'usage_events',
          doomed.map((row) => ({ ...row, is_deleted: 1, version: nextVersion() })),
        );
        deleted += doomed.length;
        const receivedAt = new Date().toISOString();
        // Pairing sets the name; later uploads keep any rename from the dashboard.
        yield* exclusive(
          Effect.gen(function* () {
            const current = yield* readDevice(deviceId);
            if (current)
              yield* writeDevice({
                ...current,
                platform: batch.device.platform,
                last_seen: receivedAt,
                sources: batch.sources ? JSON.stringify(batch.sources) : current.sources,
                pricing_updated_at: batch.pricingUpdatedAt || current.pricing_updated_at,
              });
          }),
        );
        const result = { accepted, updated, deleted, receivedAt };
        if ('pairingSecret' in authorization || result.accepted || result.updated || result.deleted) revision++;
        if (result.accepted || result.deleted) ownerRevision++;
        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && written.events
            ? Effect.suspend(() => {
                revision++;
                uncertainWritesUntil = Date.now() + 60_000;
                if (written.owners) ownerRevision++;
                return Cache.invalidateAll(windows);
              })
            : Effect.void,
        ),
      );
    });

    const readWindow = Effect.fn('ClickHouseUsageStore.readWindow')(
      function* (excludeDeviceId?: string, options: UsageReadOptions = {}) {
        const owner = ownerFilter(excludeDeviceId, options.devices);
        const window = timeFilter(options);
        const columns = latestEvents(
          eventColumns,
          // Narrow to records with any version in the window, then keep those
          // whose latest version is still inside it.
          window.where
            ? `${owner.where} AND (device_id, id) IN (SELECT device_id, id FROM usage_events WHERE ${owner.where} AND ${window.where})`
            : owner.where,
        );
        const first = yield* query(
          `SELECT * FROM (${columns}) WHERE is_deleted = 0${window.where ? ` AND ${window.where}` : ''}
          ORDER BY timestamp, device_id, id`,
          { ...owner.params, ...window.params },
        );
        let rows = first;
        if (window.where) {
          if (copiedRevision !== ownerRevision) {
            const version = ownerRevision;
            const copies = yield* query(
              `SELECT id FROM (${latestEvents(['is_deleted'])}) WHERE is_deleted = 0 GROUP BY id HAVING count() > 1`,
            );
            copiedIds = new Set(copies.map((row) => text(row.id)));
            copiedRevision = version;
          }
          // Only copied IDs need out-of-window owners. Avoid a full-history ID
          // join on the common path; include live local copies too.
          const candidates = first.map((row) => text(row.id)).filter((id) => copiedIds.has(id));
          if (candidates.length) {
            const outside = yield* latestByIds(candidates, owner, window);
            if (outside.length) {
              const merged: ClickHouseRow[] = [];
              let left = 0;
              let right = 0;
              while (left < first.length || right < outside.length) {
                if (right >= outside.length || (left < first.length && byTimestamp(first[left], outside[right]) <= 0))
                  merged.push(first[left++]);
                else merged.push(outside[right++]);
              }
              rows = merged;
            }
          }
        }
        const events = yield* decodeRows(rows);
        const metadata = yield* readMetadata(excludeDeviceId);
        return {
          events,
          sources: metadata.sources,
          warnings: [],
          pricingSnapshots: snapshotsOf(rows),
          pricingUpdatedAt: metadata.pricingUpdatedAt,
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
    const getUsage = Effect.fn('ClickHouseUsageStore.getUsage')(function* (
      excludeDeviceId?: string,
      options: UsageReadOptions = {},
    ) {
      const { candidateIds, ...windowOptions } = options;
      if (uncertainWritesUntil && Date.now() >= uncertainWritesUntil) {
        // Any late commit has landed by now; cached windows must not outlive it.
        uncertainWritesUntil = 0;
        revision++;
        ownerRevision++;
      }
      const data = uncertainWritesUntil
        ? yield* readWindow(excludeDeviceId, windowOptions)
        : yield* Cache.get(
            windows,
            JSON.stringify({ excluded: excludeDeviceId ?? '', revision, options: windowOptions }),
          );
      let events = data.events;
      let pricingSnapshots = data.pricingSnapshots;
      if (candidateIds?.length && (options.start || options.end)) {
        const rows = yield* latestByIds(
          candidateIds,
          ownerFilter(excludeDeviceId, options.devices),
          timeFilter(options),
        );
        if (rows.length) {
          const known = new Set(events.map((event) => `${event.deviceId}:${event.id}`));
          const extraRows = rows.filter((row) => !known.has(`${text(row.device_id)}:${text(row.id)}`));
          const extra = yield* decodeRows(extraRows);
          if (extra.length) {
            // The common path retains the cached array. Exceptional live local
            // copies are merged in timestamp order to preserve winner selection.
            events = [...events, ...extra].sort(
              (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
            );
            pricingSnapshots = [...pricingSnapshots, ...snapshotsOf(extraRows)];
          }
        }
      }
      const metadata = yield* readMetadata(excludeDeviceId);
      return {
        ...data,
        events,
        pricingSnapshots,
        sources: metadata.sources,
        pricingUpdatedAt: metadata.pricingUpdatedAt,
      };
    });

    const getDimensions = Effect.fn('ClickHouseUsageStore.getDimensions')(function* (excludeDeviceId?: string) {
      const rows = yield* query(
        `SELECT DISTINCT device_id AS deviceId, harness, coalesce(raw_model, model) AS model,
          coalesce(repository, project) AS project
        FROM (${latestEvents(['harness', 'model', 'raw_model', 'repository', 'project', 'is_deleted'], 'device_id != {excluded:String}')})
        WHERE is_deleted = 0`,
        { excluded: excludeDeviceId ?? '' },
      );
      return yield* Effect.try({ try: () => decodeDimensions(rows), catch: storageFailure });
    });

    const authorizeAdmin = (secret: string, action = 'Pricing changes') =>
      equalSecret(secret, pairingSecret)
        ? Effect.void
        : Effect.fail(new Unauthorized({ message: `${action} require the dashboard or its pairing secret.` }));
    const authorizeDevice = Effect.fn('ClickHouseUsageStore.authorizeDevice')(function* (
      deviceId: string,
      token: string,
    ) {
      const credentials = yield* readDevice(deviceId);
      if (!credentials || credentials.revoked_at || !equalSecret(digest(token), credentials.token_hash))
        return yield* new Unauthorized({ message: 'A connected device credential is required.' });
    });
    const deviceById = Effect.fn('ClickHouseUsageStore.deviceById')(function* (deviceId: string) {
      const device = (yield* getDevices()).find((item) => item.id === deviceId);
      if (!device)
        return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
      return device;
    });
    // Renaming and revoking only change the device row. Usage history stays.
    const renameDevice = Effect.fn('ClickHouseUsageStore.renameDevice')(function* (deviceId: string, name: string) {
      const label = name.trim();
      if (!label || label.length > 200)
        return yield* new InvalidRequest({ message: 'Enter a device name of at most 200 characters.' });
      yield* exclusive(
        Effect.gen(function* () {
          const current = yield* readDevice(deviceId);
          if (!current || current.revoked_at)
            return yield* new InvalidRequest({
              message: 'Only connected devices that are not revoked can be renamed.',
            });
          yield* writeDevice({ ...current, name: label });
        }),
      );
      revision++;
      return yield* deviceById(deviceId);
    });
    const revokeDevice = Effect.fn('ClickHouseUsageStore.revokeDevice')(function* (deviceId: string) {
      // Clearing the hash also invalidates the token; a digest never equals ''.
      yield* exclusive(
        Effect.gen(function* () {
          const current = yield* readDevice(deviceId);
          if (!current)
            return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
          yield* writeDevice({
            ...current,
            revoked_at: current.revoked_at ?? new Date().toISOString(),
            token_hash: '',
          });
        }),
      );
      return yield* deviceById(deviceId);
    });
    // Restoring only lifts the block. The old token stays discarded, so the
    // device must pair again for a new one. Restoring an unrevoked device is a no-op.
    const restoreDevice = Effect.fn('ClickHouseUsageStore.restoreDevice')(function* (deviceId: string) {
      yield* exclusive(
        Effect.gen(function* () {
          const current = yield* readDevice(deviceId);
          if (!current)
            return yield* new InvalidRequest({ message: 'This device is no longer connected to the dashboard.' });
          if (current.revoked_at) yield* writeDevice({ ...current, revoked_at: null });
        }),
      );
      return yield* deviceById(deviceId);
    });
    return {
      getDevices,
      registerDevice,
      renameDevice,
      revokeDevice,
      restoreDevice,
      syncUsage: (deviceId: string, token: string, batch: SyncBatch) => writeUsageBatch(deviceId, batch, { token }),
      importUsage: (secret: string, batch: SyncBatch) =>
        writeUsageBatch(batch.device.id, batch, { pairingSecret: secret }),
      getUsage,
      getDimensions,
      getRevision: () => revision,
      authorizeAdmin,
      authorizeDevice,
    };
  });

export const clickHouseUsageStoreLayer = (config: ClickHouseConfig, pairingSecret: string) =>
  Layer.effect(UsageStore, makeClickHouseUsageStore(config, pairingSecret));
