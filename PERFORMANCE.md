# Performance audit

## October 15 follow-up

This pass builds on the earlier audit below. It reduces browser code, dashboard repeat work, network transfers, filesystem inventory work, and Grok replay matching. Measurements use isolated fixtures. PR #11 is unmerged and undeployed; the Nexus instance has not received these changes.

The original immediate-repeat measurements did not establish performance during normal use. The five-second raw/prepared TTL and two-entry capacity caused full recomputation after pauses and range switches. Those measurements are withdrawn as evidence of durable reuse. Disk contention was not established as the cause.

### Browser loading

Production Vite manifest dependency graphs include the SvelteKit shell, layout, fallback error component, and dashboard. Raw sizes measure code the browser parses; gzip sizes compress each script independently. Chart code starts loading alongside the first data request; pricing loads when its settings page is opened. The sizes below include the settings pages subsequently merged from `main`.

| JavaScript phase                |  Before, raw / gzip |  After, raw / gzip | Raw reduction |
| ------------------------------- | ------------------: | -----------------: | ------------: |
| Initial hydration               | 395,842 / 137,303 B | 162,292 / 61,818 B |         59.0% |
| Dashboard including chart       | 395,842 / 137,303 B | 228,209 / 85,107 B |         42.3% |
| Including opened pricing editor | 395,842 / 137,303 B | 246,210 / 92,189 B |         37.8% |

The browser uses the existing unary Effect NDJSON protocol through native fetch, with RPC-derived input/output types and server-side schema validation/encoding. It checks response envelopes and the complete dashboard result structure before updating reactive state, and retains authentication, exact endpoints, bounded deadlines, abort propagation, and disposal. CLI collectors keep their Effect client. URL state uses Runed's synchronous Standard Schema interface with the same normalization behavior, removing the remaining browser Effect imports.

Structural result validation adds 2,007 raw bytes (787 gzip) to hydration. On an identical cached 4,530,489-byte all-history result served over local HTTP, median client time was 12.46 ms without the guard and 13.41 ms with it (ten alternating samples per client after two warmups). Invalid success payloads become a friendly retry error; legacy optional fields and additional fields remain compatible.

Session search indexing is deferred until search is used. Charts omit zero-value SVG bars and batch pointer updates once per frame while retaining keyboard and touch interaction. The existing chart space stays reserved during module loading. A failed chart download has an independent retry, and lazy modules ignore completion after unmount.

### Dashboard requests and transfer sizes

The cache-correction comparison uses the same 1,001,603-record SQLite snapshot, pricing state, calendar instant (`2026-10-05T05:00:00.000Z`), Los Angeles timezone, and empty local collector. Baseline is PR commit `6e2d889`; the rejected eight-history design is `ee517ed`; final caches small outputs instead. Each runs in a fresh process on the isolated Enceladus preview on port 5182. Timings include HTTP, server work, schema encoding, serialization, body reading, and JSON parsing on the same host, with identity encoding. These are individual samples, not cold-disk or production latency guarantees.

The sequence reads 7d/30d/6m twice each, waits 61 seconds, reads them again, then cycles 7d → 30d → 6m → today → all → 7d → 30d → 6m. The accounting clock is fixed for exact comparison; cache expiration and the 61-second wait use advancing real clocks. An empty-local collection counter verifies the five-second validation cache expires during the wait.

| Range | Scenario        | Baseline `6e2d889` | Rejected `ee517ed` | Final output cache |
| ----- | --------------- | -----------------: | -----------------: | -----------------: |
| 7d    | first           |           377.6 ms |           444.4 ms |           367.6 ms |
| 7d    | immediate       |            12.7 ms |            13.2 ms |            12.7 ms |
| 7d    | after-61s       |           310.6 ms |            15.3 ms |            12.9 ms |
| 7d    | range-roundtrip |           352.1 ms |            10.5 ms |            10.3 ms |
| 30d   | first           |         3,662.0 ms |         4,025.0 ms |         3,721.5 ms |
| 30d   | immediate       |            83.6 ms |            27.6 ms |            23.4 ms |
| 30d   | after-61s       |         3,638.6 ms |            24.1 ms |            23.0 ms |
| 30d   | range-roundtrip |         4,029.2 ms |            20.8 ms |            23.0 ms |
| 6m    | first           |         7,182.8 ms |         7,897.3 ms |         6,997.4 ms |
| 6m    | immediate       |            84.2 ms |           134.0 ms |           414.2 ms |
| 6m    | after-61s       |         8,443.2 ms |            88.6 ms |            83.4 ms |
| 6m    | range-roundtrip |         8,648.0 ms |            99.1 ms |            98.1 ms |

First wide reads remain expensive: retaining final outputs avoids repeating that work; it does not eliminate initial SQL decoding, pricing, or aggregation. HTTP serialization and parsing still scale with response size. All 33 full payload SHA-256 and totals/accounting SHA-256 pairs (17 idle/range reads plus 16 eight-key reads) match across all three versions. The advancing clock covers 61,138 ms in the final pause, and the empty-local collection counter advances from two to three. The 414-ms immediate six-month sample shows that cache reuse does not guarantee a sub-100-ms HTTP round trip.

Final dashboard responses and unresolved-pricing results each retain eight successful query keys. Entries contain only the response and scalar time-boundary proofs; they hold no event histories, pricing state, Effects, or closures. Eight covers all six supported ranges (today/7d/30d/90d/6m/all), one alternate timezone, and one selected-device window. Additional combinations can evict older results. Raw snapshots, prepared pricing snapshots, and decoded store windows each retain at most two keys; failed entries expire immediately. Final results remain reusable after those histories are evicted. Old data generations clear dependent caches, and pricing-only changes preserve the two raw windows.

Exact boundary-aware aggregation also checks current-time, current/previous-period event boundaries, calendar dates, query values, event-array identity, and pricing-policy identity. Final query keys include every normalized filter (harness, model, provider, project, device), requested timezone, resolved calendar window, event revision, metadata revision, local generation, and pricing revision. Model-filter order is echoed from the request even when equivalent filters share a result. Sources, warnings, generation time, machine name, and pricing check/error metadata stay current.

The original eight-history design retained overlapping decoded ranges and was rejected for its memory cost. In the complete idle/range/eight-key sequence above, immediate post-GC RSS was 3.30 GiB for baseline, 6.16 GiB for the rejected design, and 4.68 GiB for final. RSS continued falling after `Bun.gc(true)` returned, so these immediate samples do not describe settled residency.

A separate controlled memory comparison starts each version in a fresh process, opens the same eight keys twice in order, forces one full GC, and waits 30 seconds without dashboard requests before sampling. The keys are today/7d/30d/90d/6m/all in Los Angeles, 30d in UTC, and 30d for the same first populated device in Los Angeles. All 16 full-payload and accounting hash pairs match across versions. The fixture's individual serialized dashboard results range from 128,462 to 4,530,489 bytes.

| Version                                  | Immediate post-GC RSS |       RSS after 30 seconds | Live heap after 30 seconds |
| ---------------------------------------- | --------------------: | -------------------------: | -------------------------: |
| Baseline `6e2d889`, two raw windows      |              3.17 GiB | 1.44 GiB (1,546,227,712 B) |              682,665,555 B |
| Rejected `ee517ed`, eight raw windows    |              6.66 GiB | 5.43 GiB (5,835,218,944 B) |            4,201,627,200 B |
| Final, eight outputs and two raw windows |              3.68 GiB | 1.71 GiB (1,832,017,920 B) |              694,496,471 B |

Final settled RSS is 0.27 GiB above baseline, rather than the rejected design's 3.99 GiB increase; live heap differs by 11,830,916 B. These are process totals, including SQLite, decoded records, pricing, responses, and allocator overhead, not isolated cache allocations or peak-memory limits. Wide misses still allocate large temporary histories. The eight-output bound is by count, not bytes. Controlled tests verify result/session identity after raw eviction, all eight query revisits, and ninth-key eviction.

### Cache freshness and write audit

Successful entries have no timer expiry because their data revisions and calculation inputs form the key. These write paths publish revisions after a successful durable commit; cancellation before commit rolls back, while cancellation after commit cannot suppress revision publication.

| Write path                                                             | Cache effect                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sync inserts, corrections, or deletions                                | Event revision changes; decoded windows, raw snapshots, prepared prices, final responses, and aggregates refresh on the next read.                                                                     |
| Import adds missing records                                            | Same event invalidation; duplicate imports and rejected/rolled-back writes preserve revisions.                                                                                                         |
| Registration or re-registration                                        | New device/name/platform changes publish metadata revision; token rotation alone preserves usage caches.                                                                                               |
| Sync changes source diagnostics, platform, or pricing marker           | Metadata revision changes; raw/prepared/final results refresh while unchanged decoded event arrays remain reusable.                                                                                    |
| Heartbeat, identical upload, no-op sync/import                         | Last-seen/status reads are uncached; unchanged usage revisions and aggregate identity survive.                                                                                                         |
| Rename                                                                 | Changed labels publish metadata revision immediately; identical labels preserve it.                                                                                                                    |
| Revoke/restore                                                         | Only device credentials/status change. Uncached GetDevices/auth reads update immediately; dashboard history, sources, dimensions, and filter IDs are unchanged, so their revisions remain valid.       |
| Set/delete pricing rule, catalog refresh, external pricing-file change | Policy revision invalidates prepared prices/final responses/aggregates; raw usage is retained. Checked-at/error-only changes update returned metadata without rebuilding unchanged rates.              |
| Local log/T3/repository input change                                   | Local generation changes after collection if output changes; raw/prepared/final results refresh. Equal output retains aggregate identity while the latest dependency watch set is retained separately. |

Self-hosted local sources are checked at most once every five seconds using directory entries and file device/inode/size/mtime/ctime metadata. Checks do not parse logs, query T3 SQLite, serialize events, or hash event history. Configured root changes, additions/removals, same-size rewrites, Grok metadata, T3 database/WAL/environment identity, and safely discovered Git metadata are tracked. Linked Git metadata tracks both the symlink and its safely resolved target, preserving macOS protected-folder guards. Direct edits to the usage database outside application write paths are not supported invalidation signals.

Local log visibility can lag by up to the remaining five-second validation interval. Once a check detects a change, that same request awaits collection; there is no stale-while-revalidate response. Collection is shared across concurrent readers. Initial dependency discovery or files changing during collection can require a second collection in the same request. Continued change or transient metadata failure forces another validation on the next read. Full result hashing happens only after collection following a changed signal, in bounded chunks, to preserve identity for equal output. Optional repository discovery retains its existing three-second lookup/five-second total budget and protected-folder policy; intentionally skipped grouping uses recorded paths until another observed input changes.

On a separate 2,500-log/25,000-event fixture, eight alternating samples measured the old collection-plus-JSON/SHA-256 path at a median 279.55 ms elapsed / 403.90 ms CPU, and the metadata signal at 45.01 ms elapsed / 76.04 ms CPU: about 84% less elapsed time and 81% less CPU. This cost is separate from the empty-local large-SQLite benchmark. The signal still traverses directories and stats relevant files; unrelated T3 database or directory metadata changes can conservatively trigger collection.

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

All 21 compared snapshot RPC responses match exactly, including 644,734 numeric values. An independent aggregate comparison also matched 630 outputs across all six ranges, five timezones (including Lord Howe and Kathmandu), exact timestamp edges, and forward/backward clock movements. The URL adapter matched 402 validation cases. Real HTTP tests cover the new transport and gzip; a compiled chart harness covers six mouse/touch/keyboard/unmount scenarios. After integrating settings, device management, and the cache correction, the full repository test suite, formatting, lint, native TypeScript/Svelte checks, web build, CLI build, and whitespace checks pass.

Run these after building to inspect script sizes and measure a reachable service:

```sh
bun run bench:build
bun run bench http://enceladus.otter-hawksbill.ts.net:5182 30d 5
bun run bench http://enceladus.otter-hawksbill.ts.net:5182 all 5
```

The RPC command defaults to the isolated port-5182 preview and reports the first read, individual repeats, median/p95, JSON-serialized result size, and whether totals changed between reads. Immediate repeats do not establish pause/range-switch reuse: retain the server process, wait at least 60 seconds, then revisit the warmed ranges and cycle through other ranges before measuring again. Serialized result size excludes wire envelopes, compression, and HTTP headers. Authenticated deployments require a client with a valid dashboard session. The build command can accept another client output directory for before/after comparisons and reads its sibling server manifest to identify page and layout nodes. Private snapshot data and detailed evidence stay under ignored `artifacts/performance/`.

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

At the time of this earlier audit, two short cache layers could delay local log visibility and evict ordinary range revisits. The October 15 cache correction above supersedes those lifetime/capacity limits. Wide first reads and all-history response sizes remain expensive. Optional repository lookup still skips protected macOS folders, so those projects use their recorded project paths for grouping. Usage collection from normal hidden log directories does not require access to those project folders.

### Measure the running service

This command reads devices, the thirty-day dashboard twice, and pricing without changing data:

```sh
bun run bench http://enceladus.otter-hawksbill.ts.net:5182
```

It prints duration and response size for each operation. Timing depends on active uploads, cache state, source-file changes, timezone, device hardware, and network latency. Audit fixtures and rollout evidence stay in the ignored `artifacts/performance/` directory; raw conversation content is not included in uploaded usage records.
