import { createHash } from 'node:crypto';
import type { UsageEvent } from '../lib/shared/domain';
import type { Checkpoint } from './state';

// Explicit field order keeps fingerprints stable after schema/property-order
// changes. Device identity is supplied by the authenticated upload envelope.
export const eventDigest = (event: UsageEvent) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        event.id,
        event.timestamp,
        event.harness,
        event.model,
        event.project,
        event.repository,
        event.sessionId,
        event.inputTokens,
        event.outputTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.reasoningTokens,
        event.costUsd,
        event.costKnown,
        event.serviceTier,
        event.cacheWrite1hTokens,
        event.rawModel,
        ...(event.requests === undefined && event.reportedCostUsd === undefined
          ? []
          : [{ requests: event.requests, reportedCostUsd: event.reportedCostUsd }]),
        ...(event.sessionTitle === undefined &&
        event.projectName === undefined &&
        event.t3ThreadId === undefined &&
        event.t3ThreadUrl === undefined
          ? []
          : [
              {
                sessionTitle: event.sessionTitle,
                projectName: event.projectName,
                t3ThreadId: event.t3ThreadId,
                t3ThreadUrl: event.t3ThreadUrl,
              },
            ]),
      ]),
    )
    .digest('hex');

// Compute a changed record's digest once and reuse it for acknowledgement.
export const changedRecords = (events: readonly UsageEvent[], checkpoint: Checkpoint) => {
  const changed: { event: UsageEvent; digest: string }[] = [];
  for (const event of events) {
    const digest = eventDigest(event);
    if (checkpoint.eventDigests[event.id] !== digest) changed.push({ event, digest });
  }
  return changed;
};

export const changedEvents = (events: readonly UsageEvent[], checkpoint: Checkpoint) =>
  changedRecords(events, checkpoint).map((record) => record.event);

// Called only after an atomic server acknowledgement. Missing source files do
// not erase uploaded history: moving/archiving local logs is common.
export const acknowledgeEvents = (
  checkpoint: Checkpoint,
  events: readonly UsageEvent[],
  receivedAt: string,
): Checkpoint => ({
  ...checkpoint,
  syncedAt: receivedAt,
  eventDigests: {
    ...checkpoint.eventDigests,
    ...Object.fromEntries(events.map((event) => [event.id, eventDigest(event)])),
  },
  ...(checkpoint.deletedIds
    ? { deletedIds: checkpoint.deletedIds.filter((id) => !events.some((event) => event.id === id)) }
    : {}),
});

export const defaultSyncBatchMaxItems = 500;
// Half of @sveltejs/adapter-node's default 512 KiB BODY_SIZE_LIMIT so new
// collectors never fail against un-upgraded self-hosted hubs or strict proxies.
export const defaultSyncBatchMaxBytes = 256 * 1024;

export function* batchesOf<A>(values: readonly A[], limit = defaultSyncBatchMaxItems) {
  for (let offset = 0; offset < values.length; offset += limit) yield values.slice(offset, offset + limit);
}

export function* byteBudgetedBatches<A>(
  values: readonly A[],
  measure: (value: A) => number,
  options: { maxItems?: number; maxBytes?: number; overheadBytes?: number } = {},
) {
  const maxItems = Math.max(1, options.maxItems ?? defaultSyncBatchMaxItems);
  const maxBytes = Math.max(1, options.maxBytes ?? defaultSyncBatchMaxBytes);
  const overhead = Math.max(0, options.overheadBytes ?? 0);
  let batch: A[] = [];
  let bytes = overhead;
  for (const value of values) {
    const itemBytes = measure(value) + 1;
    if (batch.length > 0 && (batch.length >= maxItems || bytes + itemBytes > maxBytes)) {
      yield batch;
      batch = [];
      bytes = overhead;
    }
    batch.push(value);
    bytes += itemBytes;
  }
  if (batch.length > 0) yield batch;
}
