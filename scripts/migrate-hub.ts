import { BunRuntime } from '@effect/platform-bun';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { Console, Data, Effect, Schema } from 'effect';
import { SqlClient } from 'effect/sql';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { UsageClient, rpcClientLayer } from '../src/lib/client/rpc';
import { loadPricing } from '../src/lib/server/usage/pricing-runtime';
import { SourceStatus, UsageEvent, type SyncBatch } from '../src/lib/shared/domain';

// Copies a self-hosted hub's devices, usage records, and pricing rules into
// another hub through its ordinary RPCs, preserving record IDs, payloads, and
// pricing snapshots so later uploads from the same devices deduplicate.
//
//   TOKEN_TRACKER_PAIRING_SECRET=<target secret> bun scripts/migrate-hub.ts <source data dir> <target URL>
//
// Stop the source hub first (or copy its data directory) so no uploads arrive
// mid-migration. Rerunning is safe: unchanged records are acknowledged as no-ops.
class MigrationFailure extends Data.TaggedError('MigrationFailure')<{ readonly message: string }> {}

const [sourceArgument, targetArgument] = process.argv.slice(2);
const pairingSecret = process.env.TOKEN_TRACKER_PAIRING_SECRET ?? '';
const pageSize = 2_000;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(UsageEvent));
const decodeSources = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SourceStatus)));

const migrate = Effect.gen(function* () {
  if (!sourceArgument || !targetArgument || !pairingSecret)
    return yield* new MigrationFailure({
      message:
        'Usage: TOKEN_TRACKER_PAIRING_SECRET=<target secret> bun scripts/migrate-hub.ts <source data dir> <target URL>',
    });
  const source = resolve(sourceArgument);
  const sql = yield* SqlClient.SqlClient;
  const client = yield* UsageClient;
  // Preflight pricing before mutating the target. Dashboard reads reprice
  // imported history against the target catalog, so its rates must match.
  const pricing = yield* loadPricing(source, { strict: true });
  const targetPricing = yield* client.GetPricingPolicy({ pairingSecret });
  if (!targetPricing || !isDeepStrictEqual(pricing.policy.catalog.models, targetPricing.catalog.models))
    return yield* new MigrationFailure({
      message: 'Source and target pricing catalogs have different rates. Align the catalogs before migrating.',
    });
  const sourceModels = new Set(pricing.info.rules.map((rule) => rule.model));
  const targetOnlyModels = targetPricing.rules
    .filter((rule) => !sourceModels.has(rule.model))
    .map((rule) => rule.model);
  if (targetOnlyModels.length)
    return yield* new MigrationFailure({
      message: `Target has pricing rules absent from the source: ${targetOnlyModels.join(', ')}. Reconcile those rules before migrating.`,
    });
  const devices = yield* sql<{
    id: string;
    name: string;
    platform: string;
    sources: string;
    pricing_updated_at: string;
  }>`SELECT id, name, platform, sources, pricing_updated_at FROM devices ORDER BY name`;
  let records = 0;
  for (const row of devices) {
    const device = { id: row.id, name: row.name, platform: row.platform };
    const sync = (batch: Omit<SyncBatch, 'device'>) =>
      client.ImportUsage({ pairingSecret, batch: { device, ...batch } });
    let after = 0;
    while (true) {
      const page = yield* sql<{ rowid: number; payload: string; pricing_snapshot: string }>`
        SELECT rowid, payload, pricing_snapshot FROM usage_events
        WHERE device_id = ${device.id} AND rowid > ${after} ORDER BY rowid LIMIT ${pageSize}`;
      if (!page.length) break;
      after = page[page.length - 1].rowid;
      // Each batch carries one pricing snapshot, matching the original uploads.
      const snapshots = Map.groupBy(page, (event) => event.pricing_snapshot);
      for (const [snapshot, rows] of snapshots)
        yield* sync({
          events: rows.map((event) => decodeEvent(event.payload)),
          ...(snapshot ? { pricingUpdatedAt: snapshot } : {}),
        });
      records += page.length;
      yield* Console.log(`${device.name}: ${records.toLocaleString('en-US')} records copied`);
    }
    // The last empty batch restores the device's source diagnostics and pricing snapshot.
    yield* sync({
      events: [],
      sources: decodeSources(row.sources),
      ...(row.pricing_updated_at ? { pricingUpdatedAt: row.pricing_updated_at } : {}),
    });
  }
  // Install every source override before aliases that depend on it, including
  // alias chains whose model names sort before their targets. RPC failures must
  // stop the migration rather than report missing rules as successfully copied.
  const pending = new Map(pricing.info.rules.map((rule) => [rule.model, rule]));
  while (pending.size) {
    const ready = [...pending.values()].filter((rule) => rule.kind !== 'alias' || !pending.has(rule.target));
    if (!ready.length)
      return yield* new MigrationFailure({ message: 'Could not resolve the source pricing rule dependencies.' });
    for (const rule of ready) {
      yield* client.SetPricingRule({ rule, adminSecret: pairingSecret });
      pending.delete(rule.model);
    }
  }
  yield* Console.log(
    `Copied ${devices.length} devices, ${records.toLocaleString('en-US')} records, and ${pricing.info.rules.length} pricing rules to ${targetArgument}.`,
  );
});

migrate.pipe(
  Effect.provide(
    SqliteClient.layer({ filename: join(resolve(sourceArgument ?? '.'), 'usage.sqlite'), readonly: true }),
  ),
  Effect.provide(rpcClientLayer(new URL('/rpc', targetArgument ?? 'http://localhost').href)),
  BunRuntime.runMain,
);
