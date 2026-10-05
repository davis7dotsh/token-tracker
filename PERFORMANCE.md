# Performance audit

The October 2026 audit traced slow pricing saves through the browser, RPC handlers, SQLite queries, pricing calculations, and device collectors. The mapping write itself was fast. The browser waited for two expensive reads before confirming it, while those reads repeatedly loaded and recalculated the same history.

## Dashboard measurements

These are single-run comparisons on the same 996,628-record SQLite snapshot, with an empty local collector and the same clock, pricing policy, and filters. “First” means an application cache miss, not a cold operating-system disk cache. Repeat reads immediately follow the first read. Timings include handler work and response serialization; they do not include remote network latency.

| Operation                       |    Before |    After |
| ------------------------------- | --------: | -------: |
| Today, first read               |  7,356 ms |   182 ms |
| Today, repeat read              |  8,061 ms |     6 ms |
| Seven days, first read          |  7,900 ms |   252 ms |
| Seven days, repeat read         |  8,151 ms |    31 ms |
| Thirty days, first read         |  8,728 ms | 3,759 ms |
| Thirty days, repeat read        |  9,247 ms |   292 ms |
| Pricing for thirty days, cached |  7,040 ms |    27 ms |
| Six months, first read          | 18,485 ms | 6,650 ms |
| Six months, repeat read         | 17,890 ms |   957 ms |
| All history, first read         | 18,396 ms | 7,392 ms |
| All history, repeat read        | 19,128 ms |   948 ms |
| Mapping write                   |     24 ms |    10 ms |
| Dashboard read after mapping    |  8,784 ms |   849 ms |

An isolated browser using the real RPC returned a save confirmation in 104 ms. The compiled pricing component confirmed 15 ms after the durable acknowledgment while both background reads remained pending. Saving still waits for a successful write. Read failures retain the saved status, and cancellation/version guards prevent older responses from replacing newer edits.

After deployment, the live production browser confirmed a temporary model mapping in 60 ms, with the editor already enabled. The mapping was reset and the original three rules were preserved. A live thirty-day repeat read took 295 ms and pricing took 31 ms; the first read after restarting, including local collection, took 7.1 seconds.

## Changes

- Confirm pricing mutations from the authoritative write response, then refresh dashboard and pricing concurrently. Keep the editor usable during refreshes.
- Preserve the exact RPC endpoint to eliminate an HTTP redirect on every request.
- Use indexed canonical UTC timestamps for date windows, indexed event IDs for candidate deduplication, and transactionally maintained dimension counts for devices and filter choices. Preserve original payloads and hashes during migration.
- Batch hash lookups and writes instead of issuing one query per record. Heartbeats update device metadata without invalidating unchanged event windows; actual corrections and deletions invalidate immediately.
- Share concurrent local reads and prepared pricing results. Bound raw and prepared caches to two entries each with five-second lifetimes; bound remote window caches to two entries with a five-minute lifetime and invalidate on data revisions.
- Reuse validated pricing snapshots, alias resolution, prepared tier rates, timestamps, calendar boundaries, and model providers. Count unresolved tokens in one pass rather than building a dashboard for each unknown model.
- Index session search once per response, separate sorting from search keystrokes, use sets for filter membership, limit autocomplete work, and reuse date/number formatters.
- Stream JSONL files and cache parsed usage metadata privately. Reparse changed files completely so late model corrections remain accurate. Manual checks remain read-only.
- Index Codex replay/compaction matching and journal successful sync batches before compacting the full checkpoint once. Interrupted syncs can safely resume.
- Read only regular, bounded Git metadata files and give optional repository identification a three-second lookup deadline and five-second total collection budget. A macOS folder authorization wait must not block token sync. Successful identities are retained; unavailable identities fall back to the recorded project path.
- Skip protected macOS project folders before filesystem access, including symlinks and Git metadata pointers into those folders. Timeouts alone do not prevent permission dialogs; scheduled collection must avoid initiating optional protected reads.
- Finish CLI processes after Effect scopes finalize and stdout/stderr drain, preserving failure and signal exit codes. Cancelled optional native filesystem work can no longer keep a completed sync alive.

## Collector measurements

These are synthetic isolated workloads, not promises about each device's source history.

| Workload                                                    |   Before |                       After |
| ----------------------------------------------------------- | -------: | --------------------------: |
| Collect a 146.5 MB file containing 4,000 usage events       |   253 ms | 168 ms first / 26 ms cached |
| Peak resident memory during that first collection           |  512 MiB |                     267 MiB |
| Raw source reads on a cached collection                     |        1 |                           0 |
| Replay matching, 10,000 parent and 10,000 child events      |   428 ms |                        5 ms |
| Checkpoint work, 100,000 existing and 10,000 changed events |   272 ms |                       13 ms |
| Serialized checkpoint/journal bytes for that workload       | 175.9 MB |                     9.95 MB |

A separate pricing workload with one million records and 200 aliases fell from 3,788 ms to 98 ms. Thirty unchanged policy loads fell from 241 ms to 1 ms.

## Correctness and limits

The baseline and optimized snapshots were compared at the same clock across today, seven days, thirty days, six months, and all history. All ten dashboard responses match exactly outside filter choices, and all five pricing responses match entirely. The comparison checked 396,424 financial numeric values without rounding or tolerance. Token totals, estimated costs, sessions, previous-period accounting, groups, daily/hourly buckets, and session ordering are preserved. The dimension index exposes nine additional project filter choices from duplicated records; deduplicated usage totals retain their existing semantics.

Tests cover offset timestamp migration, original payload/hash preservation, copied records outside the selected period, large candidate-ID sets, duplicate upload acknowledgments, cache invalidation, cancellation, retry after failed reads, external pricing-file changes, daylight-saving transitions, checkpoint recovery, file rewrites, fork deduplication, and CLI output draining and finalization. A compiled browser harness covers twelve pricing mutation and background-refresh scenarios.

Wide cache misses still take seconds, and all-history responses remain large. Two short cache layers can delay visibility of local log changes by roughly ten seconds near a refresh boundary. Uploaded changes and pricing edits invalidate their dependent calculations immediately. Cache entry counts are bounded, but a wide window still retains substantial usage metadata in memory. First collector runs must populate their caches; continuously changing files are reparsed. Optional repository lookup skips protected macOS folders, so those projects use their recorded project paths for grouping. Usage collection from the normal hidden log directories does not require access to those project folders.

## Measure the running service

This command reads devices, the thirty-day dashboard twice, and pricing without changing data:

```sh
bun run bench http://enceladus.otter-hawksbill.ts.net:8787
```

It prints duration and response size for each operation. Timing depends on active uploads, cache state, source-file changes, timezone, device hardware, and network latency. Audit fixtures and rollout evidence stay in the ignored `artifacts/performance/` directory; raw conversation content is not included in uploaded usage records.
