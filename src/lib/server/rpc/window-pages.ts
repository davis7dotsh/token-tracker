import { Clock, Effect } from 'effect';
import type { SqlClient } from 'effect/sql';
import type { UsageEvent } from '../../shared/domain';
import type { StorageFailure } from '../../shared/rpc';
import { retainedDays, type DayPacks } from './day-packs';

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
  packs?: DayPacks,
) => {
  type Page = ReturnType<typeof emptyWindow> & { day: string; times: string[] };
  const lowerBound = (times: readonly string[], bound: string) => {
    let lo = 0,
      hi = times.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (times[mid] < bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let recent = new Map<string, Page>();
  let previous = new Map<string, Page>();
  const invalidate = (days: ReadonlySet<string>) => {
    for (const cache of [recent, previous]) {
      for (const [key, page] of cache) if (days.has(page.day)) cache.delete(key);
    }
  };
  const read = Effect.fn('UsageStore.readPages')(function* (
    excluded: string,
    options: UsageReadOptions,
    useDisk = true,
  ) {
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
    const now = yield* Clock.currentTimeMillis;
    const diskDays =
      useDisk && packs && options.start && options.end && !pickedDevices
        ? {
            first: utcDay(new Date(now - retainedDays * 86_400_000).toISOString()),
            today: utcDay(new Date(now).toISOString()),
          }
        : undefined;
    let fill: Effect.Success<ReturnType<DayPacks['begin']>> | undefined;
    for (const { day } of days) {
      if (!day) return yield* failure();
      // Every normalized indexed timestamp starts with <UTC date>T. Clip the
      // two edge pages exactly; timezone offsets and sub-day windows stay exact.
      const from = start > day + 'T00:00:00.000Z' ? start : day + 'T';
      const until = end < day + 'U' ? end : day + 'U';
      const bounds = `${from}/${until}`;
      let key = `${scope}:${bounds}`;
      let page = recent.get(key) ?? previous.get(key);
      // A multi-device indexed scan has device-specific tie ordering. Do not
      // substitute an all-device page when tied timestamps can reorder sessions.
      if (!page && pickedDevices?.size === 1) {
        const allKey = `${unfiltered}:${bounds}`;
        page = recent.get(allKey) ?? previous.get(allKey);
        if (page) key = allKey;
      }
      const isFull = from === day + 'T' && until === day + 'U';
      let clip = false;
      if (!page && !isFull) {
        // A range/timezone switch often clips the first day of a broader read.
        // Reuse its sorted *indexed* timestamps (the payload can use offsets).
        for (const parent of pickedDevices?.size === 1 ? [scope, unfiltered] : [scope]) {
          const full = `${parent}:${day}T/${day}U`;
          page = recent.get(full) ?? previous.get(full);
          if (page) {
            key = full;
            clip = true;
            break;
          }
        }
      }
      if (!page) {
        // A rarely used device shouldn't require a scan of every other device
        // in the bucket. Both query shapes have a matching time-ordered index.
        const index = pickedDevices ? 'usage_events_device_timestamp' : 'usage_events_timestamp';
        const loadRows = sql.unsafe<StoredRow>(
          `SELECT ${rowColumns} FROM usage_events INDEXED BY ${index}
          WHERE ${owner.where} AND timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
          [...owner.params, from, until],
        );
        const decodeRows = Effect.fnUntraced(function* (rows: readonly StoredRow[]) {
          const decoded = { day, ...emptyWindow(), times: new Array<string>() };
          for (let offset = 0; offset < rows.length; offset += 1000) {
            yield* Effect.try({
              try: () => {
                const limit = Math.min(offset + 1000, rows.length);
                for (let i = offset; i < limit; i++) {
                  const event = decode(rows[i].payload);
                  decoded.events.push(event);
                  decoded.times.push(event.timestamp === rows[i].timestamp ? event.timestamp : rows[i].timestamp);
                  decoded.pricingSnapshots.push(priceStamp(rows[i]));
                }
              },
              catch: failure,
            });
            yield* Effect.yieldNow;
          }
          return decoded;
        });
        const disk = diskDays && day >= diskDays.first && day < diskDays.today && isFull ? packs : undefined;
        const cached = disk ? yield* disk.lookup(day, excluded) : undefined;
        if (cached) page = yield* decodeRows(cached).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!page) {
          if (disk && diskDays && !fill) {
            const candidates = days
              .map((entry) => entry.day)
              .filter(
                (d) => d >= diskDays.first && d < diskDays.today && start <= d + 'T00:00:00.000Z' && end >= d + 'U',
              );
            fill = yield* disk.begin(candidates, day, excluded);
          }
          const rows = yield* loadRows;
          page = yield* decodeRows(rows);
          if (disk && fill) yield* fill.save(day, rows);
        }
      }
      used.set(key, page);
      const limit = clip ? lowerBound(page.times, until) : page.events.length;
      for (let i = clip ? lowerBound(page.times, from) : 0; i < limit; i++) {
        if (pickedDevices && !pickedDevices.has(page.pricingSnapshots[i].deviceId)) continue;
        window.events.push(page.events[i]);
        window.pricingSnapshots.push(page.pricingSnapshots[i]);
      }
    }
    if (fill) yield* fill.flush();
    if (revision() === generation) {
      previous = recent;
      recent = used;
    }
    return window;
  });
  return { read, invalidate };
};
