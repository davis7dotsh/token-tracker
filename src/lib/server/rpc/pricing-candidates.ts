import { Effect } from 'effect';
import type { SqlClient } from 'effect/sql';
import type { UsageEvent } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { repriceEvent } from '../usage/pricing';

// Two rows with this signature have the same pricing *availability*, not the
// same estimated cost. Keep this in lockstep with pricing.ts. The shape covers
// alias/legacy/Grok branches, context breaks, tier and every occupied bucket.
const field = (name: string) => `json_extract(payload, '$.${name}')`;
const input = field('inputTokens');
const output = field('outputTokens');
const read = field('cacheReadTokens');
const write = field('cacheWriteTokens');
const hour = field('cacheWrite1hTokens');
const context = `(${input} + ${read} + ${write})`;
const flags = [
  `${field('harness')} = 'grok'`,
  `${field('costKnown')} = 1`,
  `${field('reportedCostUsd')} > 0`,
  `${hour} IS NOT NULL`,
  `${input} > 0`,
  `${output} > 0`,
  `${read} > 0`,
  `${write} > COALESCE(${hour}, 0)`,
  `${write} > 0 AND ${hour} > 0`,
  `${context} > 200000`,
  `${context} > 272000`,
  // Outside the safe-integer range SQLite and JS can compare differently;
  // never use availability proved by another row for these outliers.
  `${context} + ${output} >= 9007199254740991`,
];
const shape = `json_array(COALESCE(${field('rawModel')}, ${field('model')}), ${field('serviceTier')}, ${flags
  .map((predicate, bit) => `CASE WHEN ${predicate} THEN ${2 ** bit} ELSE 0 END`)
  .join(' + ')})`;
const index = 'usage_events_pricing_shape_v1';
export const pricingShapeIndex = `CREATE INDEX IF NOT EXISTS ${index} ON usage_events(${shape})`;
const safePolicies = new WeakMap<PricingPolicy, boolean>();
const safeRates = (policy: PricingPolicy) => {
  const cached = safePolicies.get(policy);
  if (cached !== undefined) return cached;
  // Finite rates can still overflow a cost estimate. The representative only
  // proves availability for ordinary magnitudes (4 * 2^53 * 1e290 < MAX_VALUE).
  const safe =
    Object.values(policy.catalog.models).every((rates) => Object.values(rates).every((n) => n < 1e290)) &&
    policy.rules.every((rule) => rule.kind !== 'rates' || Object.values(rule.rates).every((n) => n < 1e290));
  safePolicies.set(policy, safe);
  return safe;
};

export const makePricingCandidates = (sql: SqlClient.SqlClient, decode: (payload: string) => UsageEvent) => {
  // Bounded shortcut for sparse exceptions. If most rows need attention use
  // the existing paged reader rather than materializing another full history.
  const limit = 4096;
  const localCandidates = new WeakMap<PricingPolicy, WeakMap<readonly UsageEvent[], readonly string[] | null>>();
  const readLocalIds = Effect.fnUntraced(function* (local: readonly UsageEvent[], policy: PricingPolicy) {
    let cache = localCandidates.get(policy);
    if (!cache) localCandidates.set(policy, (cache = new WeakMap()));
    const cached = cache.get(local);
    if (cached !== undefined) return cached;
    const ids: string[] = [];
    for (let i = 0; i < local.length; i++) {
      if (!repriceEvent(local[i], policy).costKnown) ids.push(local[i].id);
      if (ids.length > limit) {
        cache.set(local, null);
        return null;
      }
      if ((i + 1) % 2048 === 0) yield* Effect.yieldNow;
    }
    cache.set(local, ids);
    return ids;
  });
  return Effect.fn('UsageStore.pricingCandidates')(function* (
    excluded: string,
    local: readonly UsageEvent[],
    policy: PricingPolicy,
  ) {
    if (!safeRates(policy)) return undefined;
    const localIds = yield* readLocalIds(local, policy);
    if (!localIds) return undefined;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Jump to the next distinct index key, not SELECT DISTINCT over every
        // historical row. The representative can come from any device.
        const samples = yield* sql.unsafe<{ sampleId: string; sample: string }>(`WITH RECURSIVE shapes(signature) AS (
        SELECT (SELECT ${shape} FROM usage_events INDEXED BY ${index} ORDER BY ${shape} LIMIT 1)
        UNION ALL SELECT (SELECT ${shape} FROM usage_events INDEXED BY ${index}
          WHERE ${shape} > shapes.signature ORDER BY ${shape} LIMIT 1) FROM shapes WHERE signature IS NOT NULL
      ) SELECT CAST(rowid AS TEXT) AS sampleId, payload AS sample FROM usage_events WHERE rowid IN (
        SELECT (SELECT rowid FROM usage_events INDEXED BY ${index} WHERE ${shape} = shapes.signature LIMIT 1)
        FROM shapes WHERE signature IS NOT NULL LIMIT ${limit + 1})`);
        if (samples.length > limit) return undefined;
        const uncertain: string[] = [];
        for (const { sampleId, sample } of samples) {
          const event = decode(sample);
          if (
            event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens + event.outputTokens >=
              Number.MAX_SAFE_INTEGER ||
            !repriceEvent(event, policy).costKnown
          )
            uncertain.push(sampleId);
        }
        // Keep signature equality inside SQLite: JSON strings may contain an
        // unpaired UTF-16 surrogate which cannot round-trip as native UTF-8.
        const candidates = uncertain.length
          ? yield* sql.unsafe<{ rowId: string }>(
              `SELECT CAST(rowid AS TEXT) AS rowId FROM usage_events INDEXED BY ${index}
        WHERE ${shape} IN (SELECT ${shape} FROM usage_events WHERE rowid IN (SELECT value FROM json_each(?)))
          AND device_id <> ? LIMIT ${limit + 1}`,
              [JSON.stringify(uncertain), excluded],
            )
          : [];
        if (candidates.length > limit) return undefined;
        if (!candidates.length && !localIds.length) return { remote: [], local: [] };
        // Deduplication precedes pricing and time filters. A priced (or future)
        // winner from another device must still suppress an unpriced candidate.
        const rows = yield* sql.unsafe<{ payload: string }>(
          `WITH owners AS MATERIALIZED (
            SELECT payload,timestamp,rowid FROM usage_events INDEXED BY usage_events_record_id
            WHERE id IN (SELECT id FROM usage_events WHERE rowid IN (SELECT value FROM json_each(?))
              UNION ALL SELECT value FROM json_each(?)) AND device_id <> ? LIMIT ${limit + 1}
          ) SELECT payload FROM owners ORDER BY timestamp,rowid`,
          [JSON.stringify(candidates.map((row) => row.rowId)), JSON.stringify(localIds), excluded],
        );
        if (rows.length > limit) return undefined;
        const remote = rows.map((row) => decode(row.payload));
        const ids = new Set([...localIds, ...remote.map((event) => event.id)]);
        return { remote, local: local.filter((event) => ids.has(event.id)) };
      }),
    );
  });
};
