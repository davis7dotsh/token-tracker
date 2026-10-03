# Token tracker

A TypeScript usage tracker for Claude Code, Codex, and Pi. Effect 4 powers the CLI, collection engine, HTTP/RPC transport, and SQLite persistence. The SvelteKit dashboard and CLI share typed Effect RPC contracts. Vite+ manages the development toolchain, linting, and formatting. Bun runs the server, tests, and standalone macOS/Linux CLI builds.

The running draft is [http://enceladus.otter-hawksbill.ts.net:8787](http://enceladus.otter-hawksbill.ts.net:8787), available on the same Tailscale network.

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

The theme defaults to System, with persistent Light and Dark overrides. Initial loading, refreshes, empty results, and connection failures have separate states; existing results remain visible during refreshes.

## Local usage checks

```sh
bun run cli
bun run cli check --range 7d
bun run cli check --days 14 --project .
bun run cli check --range all --harness codex,pi --model gpt-6.1-sol --json
bun run cli check --since 2026-09-01 --until 2026-10-01
```

- The bare command and `check` report this machine over the last **30 rolling days** by default.
- Checks are read-only: no uploads, device identity creation, or sync checkpoint updates, including when a remote is configured.
- Terminal output shows total tokens, estimated API cost, harness totals, and the top five models with token counts and costs. `--json` returns the complete dashboard response.
- `--range` accepts `today`, `7d`, `30d`, `6m`, `90d`, and `all`. Six months uses calendar months. `--days` accepts a custom rolling interval; `--since`/`--until` accept ISO dates and define a start-inclusive, end-exclusive interval.
- `--project <path>` resolves repository identity, including worktrees. Harness/model filters accept comma-separated values. `--timezone` overrides the machine timezone for calendar grouping.

Git origin remotes are normalized across SSH/HTTPS and credential differences. Clones and worktrees of the same repository combine across machines. Projects without a discoverable origin fall back to local directory paths.

## Connect machines and sync

Run the dashboard on one machine, then pair each other machine once. When storage initializes, the server creates a private pairing secret at `${XDG_DATA_HOME:-~/.local/share}/token-tracker/pairing-secret`. `TOKEN_TRACKER_DATA_DIR` overrides the server data directory; `TOKEN_TRACKER_PAIRING_SECRET` supplies your own secret, at least 16 characters long.

Use that secret on the client machine:

```sh
export TOKEN_TRACKER_PAIRING_SECRET='the-secret-from-your-dashboard-machine'
bun run cli connect http://enceladus.otter-hawksbill.ts.net:8787
unset TOKEN_TRACKER_PAIRING_SECRET
```

Alternatively pass `--pairing-secret <secret>`. `--name <name>` sets the device label, `--interval <minutes>` changes the schedule, and `--no-schedule` leaves scheduling to you.

- `connect` registers the device, enables a scheduled push every **five minutes**, and uploads all available history. Terminal report timeframes do not limit syncing.
- Linux uses a user systemd timer; macOS uses a LaunchAgent. Scheduled native clients keep a durable executable copy independent of the npm cache. Configured log directories are preserved.
- Later runs send only new or changed accounting records. Stable IDs and content fingerprints detect corrections and newly imported historical logs without relying on a timestamp watermark.
- Checkpoints are written atomically after acknowledged batches. Failed uploads retry later; replaying an accepted batch does not increase totals. Archiving/removing local logs does not erase uploaded history.
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

The preview also hosts the package for a quick check from another machine on the tailnet:

```sh
bunx --package http://enceladus.otter-hawksbill.ts.net:8787/downloads/token-tracker-0.4.0.tgz token-tracker check --range 30d
npx --yes --allow-remote=root --package http://enceladus.otter-hawksbill.ts.net:8787/downloads/token-tracker-0.4.0.tgz token-tracker check --range 30d
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

Overrides accept comma-separated roots. Malformed records are skipped with diagnostics; incomplete JSONL records are reread on later checks. Collection does not follow arbitrary nested directory symlinks.

Accounting follows [ccusage](https://github.com/ccusage/ccusage) as an upstream reference; this app uses its own TypeScript collector rather than invoking the ccusage CLI. Total tokens are uncached input plus output plus cache reads plus cache writes. Reasoning is already part of output and is never added again.

Claude streamed records and Codex response identities are deduplicated. Codex cached input is separated from total input; cumulative-only records use deltas, with compaction-aware baselines and per-response counters where available. Copied records can be deduplicated across devices while device filters preserve individual-machine views.

Costs are **estimated API-equivalent costs**, calculated from a cached LiteLLM catalog and saved model rules, with the bundled snapshot in `src/lib/server/usage/pricing.json` as the initial fallback. They are not subscription charges or invoices. Supported cache TTL, service-tier, and context-length rates are accounted for. Unknown models or unavailable rates retain their tokens with cost reported as unpriced.

Open **Model pricing** beside the cost metric or in the footer. The small notification indicates models that need pricing in the selected view. The dialog shows original IDs and lets you:

- Attach an ID to an existing model. Its usage, model filters, provider, sessions, and CSV then use the target model, including its catalog pricing rules.
- Set a display nickname and custom input, output, cache-read, five-minute cache-write, and one-hour cache-write rates in USD per million tokens. Custom rates apply across service tiers and context sizes; blank cache rates stay unknown and explicit zero means free.
- Mark a model free, edit saved rules, or reset to catalog pricing.

The server stores rules and catalog data atomically in private `pricing-state.json` in its data directory. It checks for new catalog prices daily and retains the previous catalog and all rules if refreshing fails. **Refresh prices** requests an immediate update. Updated collectors preserve the original model ID, service tier, and cache duration so historical usage can be repriced consistently on the hub; older synchronized records without enough metadata keep their reported costs until their machine resyncs with the updated collector. Token totals are unaffected by pricing changes.

In this personal deployment, anyone who can access the dashboard through the tailnet can manage pricing. Browser writes require a same-origin request; direct RPC writes require the hub pairing secret. Hosted accounts will need owner roles before broader sharing.

To update the initial bundled fallback for a distribution, rebuild after running:

```sh
bun run update:pricing
```

## Tailscale access

The deployed preview listens on `100.89.249.69:8787` through a persistent user service and is accessible at [http://enceladus.otter-hawksbill.ts.net:8787](http://enceladus.otter-hawksbill.ts.net:8787).

Serve another machine directly on its tailnet address:

```sh
HOST="$(tailscale ip -4)" PORT=8787 bun run start
```

Or keep the dashboard on localhost and configure Tailscale Serve for HTTPS:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

## Verification and structure

```sh
bun run lint          # Oxlint, including type-aware rules and TypeScript checks
bun run format        # Oxfmt, including Svelte components
bun run format:check  # Check formatting without writing files
bun run check
bun test
bun run build
bun run build:cli
```

`check` synchronizes SvelteKit types, runs `vp check` for formatting/linting/TypeScript diagnostics, then runs `svelte-check --tsgo` for component types, Svelte compiler diagnostics, and CSS. `bun run check:svelte` runs just the Svelte check; `bun run lint:fix` applies safe lint fixes. Lint correctness diagnostics and Svelte warnings fail checks.

The toolchain is pinned to Vite+ 1.0.0 and the latest stable native TypeScript compiler verified during setup, 7.0.2, installed as `@typescript/native` via an npm alias. This is the released Go compiler previously published as `@typescript/native-preview`; its executable is now named `tsc`. TypeScript 6 remains installed for SvelteKit and Svelte Check's JavaScript tooling APIs. Vite+ bundles its own Go-based `oxlint-tsgolint` 7.0.2003 for type-aware linting. Formatting/lint settings live in `vite.config.ts`, with Svelte formatting enabled and generated builds, the pricing snapshot, and third-party license text excluded from formatting.

Tests cover parser deduplication/compaction, cache and pricing accounting, filtering/timezone boundaries, authenticated RPC and atomic SQLite writes, retry-safe checkpoints, historical imports/corrections, and read-only CLI checks. Linux scheduled pushes have also been exercised with the compiled binary. macOS binaries cross-compile; LaunchAgent execution needs verification on an actual Mac.

- `src/lib/server/usage`: shared collection, accounting, repository identity, and aggregation.
- `src/lib/shared`: validated data and Effect RPC contracts.
- `src/lib/server/rpc`: SQLite persistence, pairing, and HTTP/RPC handlers.
- `src/lib/client/rpc.ts`: scoped RPC client shared by Svelte and the CLI.
- `src/cli`: Effect commands, configuration, incremental sync, and scheduling.
- `src/routes` and `src/lib/components`: SvelteKit dashboard.

`POST /rpc` is the typed Effect RPC transport; `GET /api/health` reports health. CSV export is generated from displayed dashboard data in the browser.
