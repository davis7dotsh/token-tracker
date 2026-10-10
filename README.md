# Token tracker

A TypeScript usage tracker for Claude Code, Codex, Pi, and [Grok Build](https://github.com/xai-org/grok-build). Effect 4 powers the CLI, collection engine, HTTP/RPC transport, and SQLite persistence. The SvelteKit 3 dashboard and CLI share typed Effect RPC contracts. [Alchemy](https://alchemy.run) deploys the dashboard either as a self-hosted Bun service or to Cloudflare. Vite+ manages the development toolchain, linting, and formatting. Bun runs the server, tests, and standalone macOS/Linux CLI builds.

The dashboard runs on Nexus at [https://nexus.otter-hawksbill.ts.net:10007](https://nexus.otter-hawksbill.ts.net:10007), available on the same Tailscale network.

## Setup

Use [Vite+](https://viteplus.dev/guide/) with Node 24.21.0 or later and Bun 1.4.2 (selected by `packageManager`):

```sh
vp install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. For the production dashboard:

```sh
bun run build
HOST=127.0.0.1 PORT=8787 bun run start
```

The dashboard includes harness/model/provider/device/project filters, token and estimated-cost charts, session details, source diagnostics, and CSV export. The period selector switches between six months, 30 days, seven days, and today. Today shows hourly buckets in the browser's timezone, including daylight saving changes.

Runed's `useSearchParams` keeps the period, filters, chart settings, breakdown, and session search/sort/page in the URL. Copying a link or reloading restores the view; browser back/forward restores earlier selections. Chart and table controls work locally without reloading usage data.

The theme defaults to System, with persistent Light and Dark overrides. Initial loading, refreshes, empty results, and connection failures have separate states; existing results remain visible during refreshes.

## Deploy

Alchemy manages both targets from this repository. `alchemy.local.ts` runs the hub on your own machine; `alchemy.run.ts` hosts a public dashboard on Cloudflare. Alchemy state lives in `.alchemy/` (local) or your Cloudflare account (cloud) and is never committed.

### Your own machine

```sh
bun run deploy:local
```

- Builds the dashboard, installs it with its production dependencies in `${XDG_DATA_HOME:-~/.local/share}/token-tracker-dashboard`, and runs it with a pinned Bun as a user service: `token-tracker-dashboard.service` on Linux (systemd) or `sh.davis.token-tracker-dashboard` on macOS (LaunchAgent). The deploy finishes once `/api/health` responds.
- Serves `http://127.0.0.1:8787` by default. Set `HOST`, `PORT`, and `ORIGIN` when deploying; `ORIGIN` is the public URL when a proxy such as Tailscale Serve terminates HTTPS. Data, configuration, download, and log directory overrides set at deploy time (`TOKEN_TRACKER_DATA_DIR`, `TOKEN_TRACKER_CONFIG_DIR`, `TOKEN_TRACKER_DOWNLOAD_DIR`, `CLAUDE_CONFIG_DIR`, …) are passed to the service.
- The hub collects this machine's logs directly and keeps usage, the pairing secret, and pricing in its private data directory, as described below.
- Rerun `bun run deploy:local` after pulling changes; it rebuilds and restarts only when sources changed. The installed copy is independent of the checkout, so switching branches or deleting a worktree does not affect the running service.
- `bun run destroy:local` stops and removes the service and the installed app. Usage data stays in the data directory.
- On Linux, enable lingering (`loginctl enable-linger`) so user services keep running after logout.
- Other stages get separate services and install directories: `bun alchemy deploy --config alchemy.local.ts --stage test` installs `token-tracker-dashboard-test`.

### Cloudflare

```sh
bun alchemy profile edit --add Cloudflare   # once: OAuth or an API token, saved to ~/.alchemy
export TOKEN_TRACKER_PAIRING_SECRET="$(openssl rand -base64 32)"   # or put it in .env
bun run deploy:cloud
```

- Deploys the `prod` stage and prints the dashboard's `workers.dev` URL. The first deploy asks to create Alchemy's state store in your account.
- Two Workers: `Dashboard` serves SvelteKit and forwards `/rpc` and `/api/health` through a service binding to `Hub`, an Effect Worker with no public URL. `Hub` routes every request to one SQLite-backed Durable Object, the single writer for usage, devices, and pricing.
- `TOKEN_TRACKER_PAIRING_SECRET` (at least 16 characters) is read from your shell or `.env` at deploy time and bound as a Worker secret. Keep it: devices need it to pair, and pricing changes need it. Deploying with a different value rotates it.
- The page is public. Anyone with the URL can see the dashboard, including device names, project paths, and repository names. Pricing changes require the pairing secret, which the Model pricing dialog asks for.
- The hosted hub has no machine of its own. Every computer, including the one you deploy from, pairs as a client with `bun run cli connect <dashboard-url>`.
- Package downloads (`/downloads/*`) are served only by self-hosted hubs.
- `bun run dev:cloud` runs the same Workers and Durable Object locally in workerd at http://localhost:1337, without a Cloudflare account.
- `bun run destroy:cloud` deletes both Workers and the Durable Object, including its usage history.

Large histories exceed the Workers Free plan. A Free account has 5 GB of Durable Object storage in total, and a dashboard read over a million records takes several seconds of CPU. Use Workers Paid for a hub of that size.

To move an existing hub's history into another hub, stop the old hub (or copy its data directory) and replay it:

```sh
TOKEN_TRACKER_PAIRING_SECRET='the-new-hub-secret' bun scripts/migrate-hub.ts ~/.local/share/token-tracker https://your-dashboard.workers.dev
```

The script copies devices, missing usage records with their pricing snapshots, source diagnostics, and pricing rules through the new hub's RPCs. The target must run a version that supports `ImportUsage`. It checks source pricing before copying: unreadable or invalid pricing state, different source/target catalog rates, and target pricing rules absent from the source stop the migration before writing to the target. Align the catalogs and reconcile target-only rules before retrying; the script does not delete target rules automatically. Rerunning preserves existing target records and credentials for collectors already connected to the target. Then reconnect each device to the new URL; its uploads match the migrated records instead of adding usage again. A self-hosted hub's own machine does not upload to itself, so connect that machine as a client too.

## Local usage checks

```sh
bun run cli
bun run cli check --range 7d
bun run cli check --days 14 --project .
bun run cli check --range all --harness codex,pi --model gpt-6.1-sol --json
bun run cli check --harness grok
bun run cli check --since 2026-09-01 --until 2026-10-01
```

- The bare command and `check` report this machine over the last **30 rolling days** by default.
- Checks are read-only: no uploads, device identity creation, or sync checkpoint updates, including when a remote is configured.
- Terminal output shows total tokens, estimated API cost, harness totals, and the top five models with token counts and costs. `--json` returns the complete dashboard response.
- `--range` accepts `today`, `7d`, `30d`, `6m`, `90d`, and `all`. Six months uses calendar months. `--days` accepts a custom rolling interval; `--since`/`--until` accept ISO dates and define a start-inclusive, end-exclusive interval.
- `--project <path>` resolves repository identity, including worktrees. Harness/model filters accept comma-separated values. `--timezone` overrides the machine timezone for calendar grouping.

Git origin remotes are normalized across SSH/HTTPS and credential differences. Clones and worktrees of the same repository combine across machines. Projects without a discoverable origin fall back to local directory paths.

On macOS, optional Git metadata lookup skips Documents, Desktop, Downloads, and managed cloud storage, including links pointing into those locations. Background sync does not request access to historical project folders just to identify a repository. Usage still comes from the configured log directories; skipped repository lookups retain the recorded project path for grouping.

## Connect machines and sync

Run the dashboard on one machine, then pair each other machine once. When storage initializes, the server creates a private pairing secret at `${XDG_DATA_HOME:-~/.local/share}/token-tracker/pairing-secret`. `TOKEN_TRACKER_DATA_DIR` overrides the server data directory; `TOKEN_TRACKER_PAIRING_SECRET` supplies your own secret, at least 16 characters long.

Use that secret on the client machine:

```sh
export TOKEN_TRACKER_PAIRING_SECRET='the-secret-from-your-dashboard-machine'
bun run cli connect https://nexus.otter-hawksbill.ts.net:10007
unset TOKEN_TRACKER_PAIRING_SECRET
```

Alternatively pass `--pairing-secret <secret>`. `--name <name>` sets the device label, `--interval <minutes>` changes the schedule, and `--no-schedule` leaves scheduling to you.

- `connect` registers the device, enables a scheduled push every **five minutes**, and uploads all available history. Terminal report timeframes do not limit syncing.
- Linux uses a user systemd timer; macOS uses a LaunchAgent. Scheduled native clients keep a durable executable copy independent of the npm cache. Configured log directories are preserved.
- Later runs send only new or changed accounting records. Stable IDs and content fingerprints detect corrections and newly imported historical logs without relying on a timestamp watermark.
- Genuine subagent calls count once. Inherited Codex counters, Claude sidechain message replays, and Pi fork entries retain their original ownership instead of adding usage again. Codex fork accounting uses native task creation metadata because copied records can have rewritten timestamps.
- Acknowledged batches append a small checkpoint journal; a successful changed sync compacts it into an atomic snapshot. Failed uploads retry later; replaying an accepted batch does not increase totals. Archiving/removing local logs does not erase uploaded history.
- When source metadata proves a previously uploaded record was copied history, sync withdraws that identity after uploading its replacement. Withdrawals have durable acknowledgements and safe retries, including after an upload checkpoint is reset. Missing files alone never trigger withdrawals.
- Each machine pushes independently. The server does not poll machines or require incoming connections to laptops.
- Before collecting, sync downloads changed pricing rules and catalog rates from the hub into a validated local cache. Manual checks use that cache offline and remain read-only.
- Uploads contain token/cost counters and session/project metadata, never prompts, responses, tool output, or provider credentials.

```sh
bun run cli sync                 # One push
bun run cli sync --watch         # Repeated foreground pushes
bun run cli status --json        # Connection/checkpoint status
bun run cli disconnect          # Remove credentials and scheduled job
```

Disconnecting leaves existing history on the server. Client configuration and checkpoints live under `${XDG_CONFIG_HOME:-~/.config}/token-tracker`, or `TOKEN_TRACKER_CONFIG_DIR` when set. Credential/checkpoint files use mode `0600`. The server stores synchronized usage in `usage.sqlite` in its data directory. This version uses tailnet access for the dashboard and paired credentials for uploads; hosted-account login is not implemented.

## Native CLI and npm packaging

```sh
bun run build:cli
./dist/token-tracker --range 30d
./dist/token-tracker sync
```

Native local checks, pairing, sync, status, and disconnect need no installed Bun, Node, Go, or npm runtime. Building requires Bun. Cross-build the binaries used by the npm launcher:

```sh
bun run build:cli bun-linux-x64
bun run build:cli bun-linux-arm64
bun run build:cli bun-darwin-x64
bun run build:cli bun-darwin-arm64
```

The npm `token-tracker` executable selects its bundled platform binary. This draft is private and has not been published to npm. After building the dashboard and platform binaries, `bun pm pack` creates a local tarball for npm/npx:

```sh
npx --yes --package ./davis7-token-tracker-0.4.0.tgz token-tracker check --range 7d
```

The dashboard also hosts the package for a quick check from another machine on the tailnet:

```sh
bunx --package https://nexus.otter-hawksbill.ts.net:10007/downloads/token-tracker-0.4.0.tgz token-tracker check --range 30d
npx --yes --allow-remote=root --package https://nexus.otter-hawksbill.ts.net:10007/downloads/token-tracker-0.4.0.tgz token-tracker check --range 30d
```

The `--allow-remote=root` option permits this URL package on npm 12.

The dashboard runs as a separate Bun server. Native `serve` launches the packaged SvelteKit build and requires Bun on `PATH`, or an explicit `BUN_EXEC_PATH`. It defaults to `127.0.0.1:8787`; `--host`, `--port`, and `--entry <build/index.js>` override those values.

```sh
./dist/token-tracker serve --host 127.0.0.1 --port 8787
```

## Sources and calculations

| Harness     | Default log locations                                                   | Override              |
| ----------- | ----------------------------------------------------------------------- | --------------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl`; also XDG Claude projects when present  | `CLAUDE_CONFIG_DIR`   |
| Codex       | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` | `CODEX_HOME`          |
| Pi          | `~/.pi/agent/sessions/**/*.jsonl`                                       | `PI_CODING_AGENT_DIR` |
| Grok Build  | `~/.grok/sessions/**/usage.json`; legacy `updates.jsonl` fallback       | `GROK_HOME`           |

Overrides accept comma-separated roots. Malformed records are skipped with diagnostics; incomplete JSONL records are reread on later checks. Collection does not follow arbitrary nested directory symlinks.

Grok Build's native CLI stores a compact accounting ledger for each session under its [session directory](https://docs.x.ai/build/features/sessions). `GROK_HOME` can point to the Grok home directory or directly to its `sessions` directory. The collector prefers `usage.json` per-turn/model counters and reads `summary.json` session metadata, with the parent directory's `.cwd` file as a fallback for long project paths. If the ledger is missing or invalid, it streams accounting updates from the session's legacy `updates.jsonl`, including history written by Grok Build 1.0.13. Only accounting and session metadata are cached or uploaded; conversation text is discarded.

Scheduled sync and dashboard collection stream JSONL or read compact Grok accounting ledgers, caching only parsed accounting metadata. File identity, size, and nanosecond modification/change times invalidate changed files; each collection reapplies current pricing and resolves repository identity. Changed files are reparsed completely so late model metadata and corrected counters remain accurate. Manual checks read directly from source files and remain read-only.

Sessions created in T3 Code display their thread title and attached project, with links to the original conversation and Git repository. The collector matches native harness session IDs against T3's local metadata, including worktrees and scratch directories; it never guesses a thread ID from a path. Session titles open the installed T3 app using `t3code://threads/<environment-id>/<thread-id>` (including namespaced IDs such as `mcp:<uuid>`). The adjacent **Web** link uses `https://app.t3.codes/<environment-id>/<thread-id>` for mobile or any browser connected to the owning environment. Native links use the same verified environment and thread binding as the web route; they require the T3 app to handle the protocol. Repository links use credential-free HTTPS URLs. Sessions without T3 metadata keep their repository or directory name.

- T3 metadata defaults to `~/.t3/userdata`. Set `TOKEN_TRACKER_T3_DATA_DIR` to another T3 userdata directory on each collecting machine.
- Set `TOKEN_TRACKER_T3_URL` to your T3 web base URL if you use a private address instead of `https://app.t3.codes`.
- Upgrade the collector on each device and run `token-tracker sync` to backfill available historical sessions. Title and project edits refresh on later collections even when the usage logs have not changed. Old clients and stored records remain readable; missing, incompatible, or unreadable T3 metadata leaves accounting intact.

The hub keeps previously synced titles, thread links, and attached remote repositories when optional T3 metadata is unavailable. A scratch-directory fallback cannot overwrite a saved remote without a current thread binding; confirmed bindings and newly resolved cwd remotes still update repository attribution. Confirmed T3 thread deletions clear their conversation links; migrated legacy records cannot restore them.

SQLite metadata reads run in an isolated Bun process; the one-second collection deadline kills and waits for that process to exit, so a slow query cannot block the dashboard event loop.

Only thread IDs, titles, project names, and generated links accompany accounting uploads. T3 conversations, tool output, and credentials are not queried or uploaded. Search includes thread titles, project names, paths, repository identities, and thread IDs; CSV exports include the thread and repository links.

Accounting follows [ccusage](https://github.com/ccusage/ccusage) as an upstream reference; this app uses its own TypeScript collector rather than invoking the ccusage CLI. Total tokens are uncached input plus output plus cache reads plus cache writes. Reasoning is already part of output and is never added again.

Claude streamed records and Codex response identities are deduplicated. Claude advisor iterations count as additional calls under their own model; ordinary iterations repeat the main usage and are not added again. Native Claude message identities remain stable across streamed timestamps and transcript UUIDs. Codex cached input is separated from total input; cumulative-only records use deltas, with compaction-aware baselines and per-response counters where available. Copied records can be deduplicated across devices while device filters preserve individual-machine views. Pi preserves one-hour cache-write counts for pricing without adding them again to token totals.

Grok Build's input counters include cached tokens, so the collector separates cache reads/writes from uncached input before totaling usage. Reasoning is already included in output. A ledger row can represent several model calls; its request count preserves those calls rather than counting the row as a single request. Grok costs use complete positive native USD accounting by default. These aggregate rows do not expose each call's context size, so automatic catalog estimates are not applied. Explicit saved pricing rules can override native costs; resetting a rule restores the original reported cost without requiring another device sync. Without an explicit pricing rule, absent or partial native costs remain unpriced. Subscription sessions may omit native costs, which do not represent subscription charges.

Inherited Grok fork turns retain their original session ownership and are counted once. Parent turns already include subagent usage, so child sessions are excluded; missing readable parent accounting produces a partial-source warning. Subagent totals can lag until the parent writes its next durable turn.

Costs are **API-equivalent costs**, using native Grok accounting as described above and estimates from a cached LiteLLM catalog and saved model rules for other harnesses. The bundled snapshot in `src/lib/server/usage/pricing.json` is the initial catalog fallback. These costs are not subscription charges or invoices. Supported cache TTL, service-tier, and context-length rates are accounted for. Unknown models or unavailable costs retain their tokens with cost reported as unpriced.

Open **Model pricing** beside the cost metric or in the footer. The small notification indicates models that need pricing in the selected view. The dialog shows original IDs and lets you:

- Attach an ID to an existing model. Its usage, model filters, provider, sessions, and CSV then use the target model, including its catalog pricing rules.
- Set a display nickname and custom input, output, cache-read, five-minute cache-write, and one-hour cache-write rates in USD per million tokens. Custom rates apply across service tiers and context sizes; blank cache rates stay unknown and explicit zero means free.
- Mark a model free, edit saved rules, or reset to default pricing.

The server stores rules and catalog data atomically in private `pricing-state.json` in its data directory. It checks for new catalog prices daily and retains the previous catalog and all rules if refreshing fails. **Refresh prices** requests an immediate update. Updated collectors preserve the original model ID, service tier, cache duration, and complete native Grok cost so historical usage can be repriced consistently on the hub; older synchronized records without enough metadata keep their reported costs until their machine resyncs with the updated collector. Token totals are unaffected by pricing changes.

On a self-hosted hub, anyone who can access the dashboard through the tailnet can manage pricing. Browser writes require a same-origin request; direct RPC writes require the hub pairing secret. The public Cloudflare dashboard always requires the pairing secret. Hosted accounts will need owner roles before broader sharing.

To update the initial bundled fallback for a distribution, rebuild after running:

```sh
bun run update:pricing
```

## Tailscale access

Nexus runs the self-hosted dashboard. Bun listens on `127.0.0.1:8787`; Tailscale Serve terminates HTTPS on port `10007`. This keeps the dashboard private to the tailnet and leaves Nexus's other HTTPS services untouched. The public origin lets browser pricing edits pass the same-origin check:

```sh
ORIGIN=https://nexus.otter-hawksbill.ts.net:10007 \
TOKEN_TRACKER_DOWNLOAD_DIR=/home/davis/services/token-tracker/artifacts/downloads \
bun run deploy:local
tailscale serve --bg --https=10007 http://127.0.0.1:8787
tailscale serve status
curl -fsS https://nexus.otter-hawksbill.ts.net:10007/api/health
```

To switch Nexus from the previous hand-installed unit, stop it first (`systemctl --user disable --now token-tracker.service`), then deploy. Both use the same data directory, so no data moves.

The hub's durable state is `usage.sqlite`, `pairing-secret`, and `pricing-state.json` in `${XDG_DATA_HOME:-~/.local/share}/token-tracker`, or `TOKEN_TRACKER_DATA_DIR` when configured. Keep an immutable migration backup separate from the live data directory. Stop the old hub before taking the final SQLite backup so no acknowledged uploads arrive after the snapshot; use SQLite's backup API or copy only after the database has closed, accounting for any WAL files.

When moving an existing hub, migrate its database, pairing secret, and pricing state together. Each client retains its own `device-id`, connection token, and checkpoint digests. Pause scheduled and interactive sync before atomically changing `connection.json.url`, `checkpoint.json.remote`, and matching `checkpoint-journal.jsonl` entries to the new canonical URL, then resume the existing schedule. Changing only the connection URL safely replays available history but loses incremental checkpoint matching; reconnecting also rotates that client's token.

Keep Nexus's existing device identity distinct from Enceladus's; do not copy the old host's client configuration onto Nexus. The dashboard collects its host's own logs directly and excludes that same device's stored rows. Verify those logs cover its stored history before changing hosts. Enceladus continues as a scheduled client so its local usage remains visible on Nexus, alongside the other devices.

## Verification and structure

See [PERFORMANCE.md](PERFORMANCE.md) for the performance audit and measurements. To measure the running dashboard without changing its data:

```sh
bun run bench https://nexus.otter-hawksbill.ts.net:10007
```

```sh
bun run lint          # Oxlint, including type-aware rules and TypeScript checks
bun run format        # Oxfmt, including Svelte components
bun run format:check  # Check formatting without writing files
bun run check
bun test
bun run build
bun run build:cli
```

Zed uses the project settings in `.zed/settings.json` to format supported source files on save through the local `vp fmt` command. It reads the same `fmt` settings in `vite.config.ts` as the command-line checks.

`check` synchronizes SvelteKit types, runs `vp check` for formatting/linting/TypeScript diagnostics, then runs `svelte-check --tsgo` for component types, Svelte compiler diagnostics, and CSS. `bun run check:svelte` runs just the Svelte check; `bun run lint:fix` applies safe lint fixes. Lint correctness diagnostics and Svelte warnings fail checks.

The toolchain is pinned to Vite+ 1.0.0 and the latest stable native TypeScript compiler verified during setup, 7.0.2, installed as `@typescript/native` via an npm alias. This is the released Go compiler previously published as `@typescript/native-preview`; its executable is now named `tsc`. TypeScript 6 remains installed for SvelteKit and Svelte Check's JavaScript tooling APIs. Vite+ bundles its own Go-based `oxlint-tsgolint` 7.0.2003 for type-aware linting. Formatting/lint settings live in `vite.config.ts`, with Svelte formatting enabled and generated builds, the pricing snapshot, and third-party license text excluded from formatting.

Runed 0.37.1 is pinned with a Bun patch in `patches/` for SvelteKit 3's shallow URL/navigation APIs, matching server-rendered URL state, literal string parameters, and per-update history behavior. Recheck the patch when upgrading Runed or SvelteKit.

Tests cover parser deduplication/compaction, cache and pricing accounting, filtering/timezone boundaries, authenticated RPC and atomic SQLite writes, retry-safe checkpoints, historical imports/corrections, and read-only CLI checks. Linux scheduled pushes have also been exercised with the compiled binary. macOS binaries cross-compile; LaunchAgent execution needs verification on an actual Mac.

- `src/lib/server/usage`: shared collection, accounting, repository identity, and aggregation.
- `src/lib/shared`: validated data and Effect RPC contracts.
- `src/lib/server/rpc`: SQLite persistence, pairing, and HTTP/RPC handlers.
- `src/lib/client/rpc.ts`: scoped RPC client shared by Svelte and the CLI.
- `src/cli`: Effect commands, configuration, incremental sync, and scheduling.
- `src/routes` and `src/lib/components`: SvelteKit dashboard.
- `src/lib/server/host`: the `#hub` request handler for each host. Bun builds use `bun.ts`; the Cloudflare stack aliases `cloudflare.ts`.
- `src/cloud`: the Cloudflare Hub Worker and its SQLite Durable Object.
- `src/deploy`: the Alchemy resource that installs the self-hosted dashboard service.
- `alchemy.local.ts` and `alchemy.run.ts`: the self-hosted and Cloudflare stacks.

`POST /rpc` is the typed Effect RPC transport; `GET /api/health` reports health. CSV export is generated from displayed dashboard data in the browser.
