import type { UsageEvent } from '../../shared/domain';
import type { PricingPolicy } from '../../shared/pricing';
import { tokenCostParts } from './pricing';

const eventTimestamps = new WeakMap<UsageEvent, number>();
export const eventMillis = (event: UsageEvent) => {
  const cached = eventTimestamps.get(event);
  if (cached !== undefined) return cached;
  const millis = Date.parse(event.timestamp);
  eventTimestamps.set(event, millis);
  return millis;
};

const makeRow = (event: UsageEvent, millis: number, index: number, cost: ReturnType<typeof tokenCostParts>) => ({
  event: { ...event, requests: event.requests ?? 1 },
  // Always sum the original per-request costs: a summed row does not have the
  // same context, tier, or cache-duration price as its individual requests.
  cost: cost && { ...cost },
  min: millis,
  max: millis,
  maxIndex: index,
  startedAt: event.timestamp,
  lastActiveAt: event.timestamp,
});
type Row = ReturnType<typeof makeRow>;
const sameDimensions = (a: UsageEvent, b: UsageEvent) =>
  a.deviceId === b.deviceId &&
  a.harness === b.harness &&
  a.model === b.model &&
  a.project === b.project &&
  a.repository === b.repository &&
  a.costKnown === b.costKnown &&
  a.sessionTitle === b.sessionTitle &&
  a.projectName === b.projectName &&
  a.t3ThreadId === b.t3ThreadId &&
  a.t3ThreadUrl === b.t3ThreadUrl;

type Block = { start: number; end: number; rows?: Row[]; min: number; max: number };
// Storage reuses immutable UTC pages across writes and overlapping date ranges.
// Keep only the previous plan's compact blocks, weakly owned by their first
// record. Verify *every* identity before reuse: middle corrections/deletions
// or a change in deduplicated ownership cannot survive a cache hit.
let previousBlocks = new WeakMap<UsageEvent, { policy: PricingPolicy; inputs: readonly UsageEvent[]; rows: Row[] }>();
const prepare = (events: readonly UsageEvent[], policy: PricingPolicy) => {
  const blocks: Block[] = [];
  const nextBlocks: typeof previousBlocks = new WeakMap();
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    const first = eventMillis(events[start]);
    let min = first;
    let max = first;
    const hourEnd = (Math.floor(first / 3_600_000) + 1) * 3_600_000;
    const limit = Math.min(events.length, start + 2048);
    while (end < limit) {
      const millis = eventMillis(events[end]);
      if (!(millis >= hourEnd - 3_600_000 && millis < hourEnd)) break;
      min = Math.min(min, millis);
      max = Math.max(max, millis);
      end++;
    }
    let rows: Row[] | undefined;
    const old = previousBlocks.get(events[start]);
    if (
      old &&
      old.policy === policy &&
      old.inputs.length === end - start &&
      old.inputs.every((value, i) => value === events[start + i])
    ) {
      rows = old.rows;
      nextBlocks.set(events[start], old);
    } else if (end - start >= 8 && Number.isFinite(first)) {
      const groups = new Map<string, Row>();
      const compact: Row[] = [];
      for (let index = start; index < end; index++) {
        const event = events[index];
        const millis = eventMillis(event);
        const cost = tokenCostParts(event, policy);
        const row = groups.get(event.sessionId);
        if (!row || !sameDimensions(row.event, event) || (row.cost === undefined) !== (cost === undefined)) {
          const created = makeRow(event, millis, index - start, cost);
          compact.push(created);
          // Only merge the last group for a session. Interleaved sessions can
          // collapse; metadata/model changes within a session keep their order.
          groups.set(event.sessionId, created);
          continue;
        }
        const sum = row.event;
        sum.inputTokens += event.inputTokens;
        sum.outputTokens += event.outputTokens;
        sum.cacheReadTokens += event.cacheReadTokens;
        sum.cacheWriteTokens += event.cacheWriteTokens;
        sum.reasoningTokens += event.reasoningTokens;
        sum.requests += event.requests ?? 1;
        sum.costUsd += event.costUsd;
        if (row.cost && cost) {
          row.cost.input += cost.input;
          row.cost.output += cost.output;
          row.cost.cacheRead += cost.cacheRead;
          row.cost.cacheWrite += cost.cacheWrite;
        }
        row.min = Math.min(row.min, millis);
        if (millis > row.max) {
          row.max = millis;
          row.maxIndex = index - start;
          sum.timestamp = event.timestamp;
        }
        if (event.timestamp < row.startedAt) row.startedAt = event.timestamp;
        if (event.timestamp > row.lastActiveAt) row.lastActiveAt = event.timestamp;
      }
      // High-cardinality histories are cheaper to scan than to keep a second
      // near-event-sized index. Bound each speculative build to one block.
      if (compact.length <= (end - start) / 2) {
        rows = compact;
        nextBlocks.set(events[start], { policy, inputs: events.slice(start, end), rows });
      }
    }
    const last = blocks.at(-1);
    if (!rows && last && !last.rows) last.end = end;
    else blocks.push({ start, end, min, max, rows });
    start = end;
  }
  previousBlocks = nextBlocks;
  return blocks;
};
const indices = new WeakMap<readonly UsageEvent[], { policy: PricingPolicy; blocks: Block[] }>();
export const forEachDashboardRow = (
  events: readonly UsageEvent[],
  policy: PricingPolicy,
  sameBucket: (min: number, max: number) => boolean,
  visit: (event: UsageEvent, index: number, row?: Row) => void,
) => {
  if (events.length < 512) {
    events.forEach((event, index) => visit(event, index));
    return;
  }
  let index = indices.get(events);
  if (!index || index.policy !== policy) {
    index = { policy, blocks: prepare(events, policy) };
    indices.set(events, index);
  }
  for (const block of index.blocks) {
    // Never approximate a rolling boundary or a local day/hour (including
    // non-hour timezone offsets). Replay only those boundary blocks exactly.
    if (block.rows && sameBucket(block.min, block.max)) {
      for (const row of block.rows) visit(row.event, block.start + row.maxIndex, row);
    } else {
      for (let i = block.start; i < block.end; i++) visit(events[i], i);
    }
  }
};
