import { Effect } from 'effect';
import type { SqlClient } from 'effect/sql';
import type { UsageEvent } from '../../shared/domain';
import type { StorageFailure } from '../../shared/rpc';

export type UsageReadOptions = {
  start?: string;
  end?: string;
  devices?: readonly string[];
  candidateIds?: readonly string[];
};
type EventRow = { id: string; device_id: string; payload: string; pricing_snapshot: string };
export type StoredRow = EventRow & { timestamp: string };
export type PriceStamp = { eventId: string; deviceId: string; updatedAt: string };
const emptyWindow = () => ({ events: new Array<UsageEvent>(), pricingSnapshots: new Array<PriceStamp>() });
export const priceStamp = (row: EventRow): PriceStamp => ({
  eventId: row.id,
  deviceId: row.device_id,
  updatedAt: row.pricing_snapshot,
});
export const ownerFilter = (excluded: string, devices?: readonly string[]) => ({
  where: `device_id <> ?${devices?.length === 1 ? ' AND device_id = ?' : devices ? ' AND device_id IN (SELECT value FROM json_each(?))' : ''}`,
  params: devices ? [excluded, devices.length === 1 ? devices[0] : JSON.stringify(devices)] : [excluded],
});
const eventColumns = 'id, device_id, payload, pricing_snapshot';
export const rowColumns = `${eventColumns}, timestamp`;
export type EventWindow = ReturnType<typeof emptyWindow>;
export const utcDay = (timestamp: string) => timestamp.slice(0, timestamp.indexOf('T'));

// Reuse immutable, validated records across range/device switches and uploads.
// Retain only pages used by the two most recent reads (not every visited range).
export const makeWindowPages = (
  sql: SqlClient.SqlClient,
  decode: (json: string) => UsageEvent,
  revision: () => number,
  failure: () => StorageFailure,
) => {
  type Page = ReturnType<typeof emptyWindow> & { day: string };
  let recent = new Map<string, Page>();
  let previous = new Map<string, Page>();
  const invalidate = (days: ReadonlySet<string>) => {
    for (const cache of [recent, previous]) {
      for (const [key, page] of cache) if (days.has(page.day)) cache.delete(key);
    }
  };
  const read = Effect.fn('UsageStore.readPages')(function* (excluded: string, options: UsageReadOptions) {
    const generation = revision();
    const window = emptyWindow();
    if (options.devices?.every((id) => id === excluded)) return window;
    const pickedDevices = options.devices && new Set(options.devices);
    const owner = ownerFilter(excluded, options.devices);
    const start = options.start || '';
    const end = options.end || '\uffff';
    // Seek to the next occupied UTC day in the timestamp index. Unlike a
    // GROUP BY or materializing every date between min/max, this visits one
    // index entry per nonempty day, including for sparse all-time histories.
    const onlyDevice = options.devices?.length === 1 ? sql`device_id = ${options.devices[0]} AND` : sql``;
    const days = yield* sql<{ day: string }>`WITH RECURSIVE days(t) AS (
      SELECT MIN(timestamp) FROM usage_events WHERE ${onlyDevice} timestamp >= ${start} AND timestamp < ${end}
      UNION ALL SELECT (SELECT MIN(timestamp) FROM usage_events
        WHERE ${onlyDevice} timestamp >= substr(t, 1, instr(t,'T') - 1) || 'U' AND timestamp < ${end})
      FROM days WHERE t IS NOT NULL AND instr(t,'T') > 0
    ) SELECT substr(t, 1, instr(t,'T') - 1) AS day FROM days WHERE t IS NOT NULL ORDER BY t`;
    const used = new Map<string, Page>();
    const scope = JSON.stringify([excluded, options.devices ?? null]);
    const unfiltered = JSON.stringify([excluded, null]);
    for (const { day } of days) {
      if (!day) return yield* failure();
      // Every normalized indexed timestamp starts with <UTC date>T. Clip the
      // two edge pages exactly; timezone offsets and sub-day windows stay exact.
      const from = start > day + 'T00:00:00.000Z' ? start : day + 'T';
      const until = end < day + 'U' ? end : day + 'U';
      const bounds = `${from}/${until}`;
      let key = `${scope}:${bounds}`;
      let page = recent.get(key) ?? previous.get(key);
      if (!page && pickedDevices) {
        const allKey = `${unfiltered}:${bounds}`;
        page = recent.get(allKey) ?? previous.get(allKey);
        if (page) key = allKey;
      }
      if (!page) {
        // A rarely used device shouldn't require a scan of every other device
        // in the bucket. Both query shapes have a matching time-ordered index.
        const index = pickedDevices ? 'usage_events_device_timestamp' : 'usage_events_timestamp';
        const rows = yield* sql.unsafe<EventRow>(
          `SELECT ${eventColumns} FROM usage_events INDEXED BY ${index}
          WHERE ${owner.where} AND timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
          [...owner.params, from, until],
        );
        page = { day, ...emptyWindow() };
        const decoded = page;
        for (let offset = 0; offset < rows.length; offset += 1000) {
          yield* Effect.try({
            try: () => {
              const limit = Math.min(offset + 1000, rows.length);
              for (let i = offset; i < limit; i++) {
                decoded.events.push(decode(rows[i].payload));
                decoded.pricingSnapshots.push(priceStamp(rows[i]));
              }
            },
            catch: failure,
          });
          yield* Effect.yieldNow;
        }
      }
      used.set(key, page);
      for (let i = 0; i < page.events.length; i++) {
        if (pickedDevices && !pickedDevices.has(page.pricingSnapshots[i].deviceId)) continue;
        window.events.push(page.events[i]);
        window.pricingSnapshots.push(page.pricingSnapshots[i]);
      }
    }
    if (revision() === generation) {
      previous = recent;
      recent = used;
    }
    return window;
  });
  return { read, invalidate };
};
