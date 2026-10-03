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
      ]),
    )
    .digest('hex');

export const changedEvents = (events: readonly UsageEvent[], checkpoint: Checkpoint) =>
  events.filter((event) => checkpoint.eventDigests[event.id] !== eventDigest(event));

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
});

export const batchesOf = <A>(values: readonly A[], limit = 500) =>
  Array.from({ length: Math.ceil(values.length / limit) }, (_, index) =>
    values.slice(index * limit, (index + 1) * limit),
  );
