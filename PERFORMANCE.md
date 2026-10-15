# Performance audit

## October 15 follow-up

This pass builds on the earlier audit below. It reduces browser code, dashboard repeat work, network transfers, filesystem inventory work, and Grok replay matching. All measurements use isolated fixtures; the production database, pricing rules, collector identities, and schedules were preserved.

### Browser loading

Production Vite manifest dependency graphs include the SvelteKit shell, layout, fallback error component, and dashboard. Raw sizes measure code the browser parses; gzip sizes compress each script independently. Chart code starts loading alongside the first data request; pricing loads when its settings page is opened. The sizes below include the settings pages subsequently merged from `main`.

| JavaScript phase                |  Before, raw / gzip |  After, raw / gzip | Raw reduction |
| ------------------------------- | ------------------: | -----------------: | ------------: |
| Initial hydration               | 395,842 / 137,303 B | 160,285 / 61,031 B |         59.5% |
| Dashboard including chart       | 395,842 / 137,303 B | 226,202 / 84,320 B |         42.9% |
| Including opened pricing editor | 395,842 / 137,303 B | 244,203 / 91,403 B |         38.3% |

The browser uses the existing unary Effect NDJSON protocol through native fetch, with RPC-derived input/output types and server-side schema validation/encoding. It checks response envelopes and retains authentication, exact endpoints, bounded deadlines, abort propagation, and disposal. CLI collectors keep their Effect client. URL state uses Runed's synchronous Standard Schema interface with the same normalization behavior, removing the remaining browser Effect imports.

Session search indexing is deferred until search is used. Charts omit zero-value SVG bars and batch pointer updates once per frame while retaining keyboard and touch interaction. The existing chart space stays reserved during module loading. A failed chart download has an independent retry, and lazy modules ignore completion after unmount.

### Dashboard requests and transfer sizes

The RPC comparison uses the same 1,001,603-record SQLite snapshot, pricing state, fixed clock (`2026-10-05T05:00:00.000Z`), Los Angeles timezone, and empty local collector. Timings include HTTP, server work, schema encoding, serialization, body reading, and JSON parsing on the same host. Identity encoding isolates request computation from the separate compression measurements. The table shows the median of two immediate repeat reads per range, not a cold-disk measurement or a field latency guarantee.

| Repeated dashboard request |     Before |    After |
| -------------------------- | ---------: | -------: |
| Today                      |    14.8 ms |   3.5 ms |
| Seven days                 |    44.4 ms |   7.2 ms |
| Thirty days                |   367.4 ms |  18.8 ms |
| Six months                 | 1,169.2 ms | 150.2 ms |
| All history                | 1,282.1 ms | 249.3 ms |

The second warm all-history request took 85.5 ms. The first repeat of a wide query can refresh prepared data after its five-second lifetime, so the table includes that cost. Wide first requests remain expensive and variable: a thirty-day application-cache miss took 3.96 seconds before and 3.85 seconds after; six-month/all-history misses still take seconds. The measured gains are strongest for repeated work, browser downloads, and network transfer.

Exact boundary-aware aggregation reuses prepared immutable results until a relevant event crosses the current-time, current-period, or previous-period boundary. It also checks day/calendar changes, query values, event-array identity, and pricing-policy identity. Sources, warnings, generation time, machine name, and pricing timestamps remain fresh. Two aggregate entries per live event array are owned by a WeakMap; there is no added stale-data TTL.

Raw snapshots now retain deduplication winners and unique filter dimensions across pricing recalculation. A transactionally maintained copied-ID table replaces a full historical `GROUP BY` after uploads: on this snapshot, the lookup fell from 105–106 ms to 5.5–6.9 ms. Initialization backfills existing copies once; insertion, correction, withdrawal, rollback, and reopen tests preserve owner selection.

Self-hosted RPC responses negotiate native streaming gzip for accepted JSON/NDJSON replies of at least 1 KiB in the first chunk. Explicit refusal, small replies, existing encodings, no-transform responses, downloads, backpressure, and cancellation retain their semantics. Measured native stream costs below are medians of ten samples after two warmups; decoded hashes match exactly.

| Response    | Identity bytes | Gzip bytes | Smaller |   Added CPU |
| ----------- | -------------: | ---------: | ------: | ----------: |
| Thirty days |        998,346 |    167,804 |   83.2% |  about 9 ms |
| All history |      4,530,564 |    729,654 |   83.9% | about 33 ms |

### Collection

| Isolated workload                                            |      Before |     After |
| ------------------------------------------------------------ | ----------: | --------: |
| Warm inventory: 2,500 logs, 2,500 other files, 25,000 events |   516.65 ms | 255.09 ms |
| Grok: 5,000 turns plus 5,000 completion replays              | 3,673.76 ms |  35.72 ms |

Directory entries replace 5,100 `readLink` and 5,100 `stat` calls per inventory in that fixture. Configured root aliases still resolve; nested symlinks, broken links, and special files remain excluded, and unreadable directories still produce partial diagnostics. Optional macOS repository safeguards are unchanged.

Grok replay corrections now index complete turn results instead of scanning all prior events for each replay. Replacement ordering, whole-turn model replacement, malformed correction rejection, zero-usage withdrawal, token totals, and serialized result checksums match the baseline.

### Verification and reproduction

All 21 compared snapshot RPC responses match exactly, including 644,734 numeric values. An independent aggregate comparison also matched 630 outputs across all six ranges, five timezones (including Lord Howe and Kathmandu), exact timestamp edges, and forward/backward clock movements. The URL adapter matched 402 validation cases. Real HTTP tests cover the new transport and gzip; a compiled chart harness covers six mouse/touch/keyboard/unmount scenarios. After integrating settings and device management, the full repository suite passes 307 tests, plus formatting, lint, native TypeScript/Svelte checks, web build, CLI build, and whitespace checks.

Run these after building to inspect script sizes and measure a reachable service:

```sh
bun run bench:build
bun run bench http://enceladus.otter-hawksbill.ts.net:8787 30d 5
bun run bench http://enceladus.otter-hawksbill.ts.net:8787 all 5
```

The RPC command reports the first read, individual repeats, median/p95, JSON-serialized result size, and whether totals changed between reads. Serialized result size excludes wire envelopes, compression, and HTTP headers. Authenticated deployments require a client with a valid dashboard session. The build command can accept another client output directory for before/after comparisons and reads its sibling server manifest to identify page and layout nodes. Private snapshot data and detailed evidence stay under ignored `artifacts/performance/`.

## Earlier October audit

The October 2026 audit traced slow pricing saves through the browser, RPC handlers, SQLite queries, pricing calculations, and device collectors. The mapping write itself was fast. The browser waited for two expensive reads before confirming it, while those reads repeatedly loaded and recalculated the same history.

### Dashboard measurements

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

### Changes

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

### Collector measurements

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

### Correctness and limits

The baseline and optimized snapshots were compared at the same clock across today, seven days, thirty days, six months, and all history. All ten dashboard responses match exactly outside filter choices, and all five pricing responses match entirely. The comparison checked 396,424 financial numeric values without rounding or tolerance. Token totals, estimated costs, sessions, previous-period accounting, groups, daily/hourly buckets, and session ordering are preserved. The dimension index exposes nine additional project filter choices from duplicated records; deduplicated usage totals retain their existing semantics.

Tests cover offset timestamp migration, original payload/hash preservation, copied records outside the selected period, large candidate-ID sets, duplicate upload acknowledgments, cache invalidation, cancellation, retry after failed reads, external pricing-file changes, daylight-saving transitions, checkpoint recovery, file rewrites, fork deduplication, and CLI output draining and finalization. A compiled browser harness covers twelve pricing mutation and background-refresh scenarios.

Wide cache misses still take seconds, and all-history responses remain large. Two short cache layers can delay visibility of local log changes by roughly ten seconds near a refresh boundary. Uploaded changes and pricing edits invalidate their dependent calculations immediately. Cache entry counts are bounded, but a wide window still retains substantial usage metadata in memory. First collector runs must populate their caches; continuously changing files are reparsed. Optional repository lookup skips protected macOS folders, so those projects use their recorded project paths for grouping. Usage collection from the normal hidden log directories does not require access to those project folders.

### Measure the running service

This command reads devices, the thirty-day dashboard twice, and pricing without changing data:

```sh
bun run bench http://enceladus.otter-hawksbill.ts.net:8787
```

It prints duration and response size for each operation. Timing depends on active uploads, cache state, source-file changes, timezone, device hardware, and network latency. Audit fixtures and rollout evidence stay in the ignored `artifacts/performance/` directory; raw conversation content is not included in uploaded usage records.
