# Token Tracker

A private, multi-device CLI that imports Codex, Claude Code, and Pi token
history into SQLite. A standalone installation remains local-only. A host
combines revisioned session summaries from its own collector and any enrolled
client nodes. Clients push updates directly to the host over native Erlang
distribution; clients never form a mesh and the host never polls them.

The first collection scans all existing history. Later collections skip
unchanged files using durable checkpoints.

## Data

Token Tracker reads:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`
- `~/.claude/projects/**/*.jsonl`
- `~/.pi/agent/sessions/**/*.jsonl`

It stores only timestamps, agent and model-provider names, safe project names,
model names, token counters, session counts, and hashed event/session/path
identities. It does not store raw paths, session IDs, prompts, responses, or
transcript contents. Transcript backup is intentionally deferred.

State lives under:

```text
~/.token-tracker/
  usage.sqlite3
  pricing-cache.json
  config.toml
  enrollments/
```

Set `TOKEN_TRACKER_HOME` or pass `--home PATH` to move the entire home
directory.

## Install and run

Elixir 1.18 or newer and Erlang/OTP are required.

```sh
mix deps.get
mix token_tracker.install
token-tracker collect
```

Installation creates a Mix release under `~/.local/lib/token-tracker` and puts
the `token-tracker` launcher in `~/.local/bin`. A release is used instead of an
escript because SQLite's native library must exist as a normal file at runtime.

## CLI

```text
token-tracker setup host|client
token-tracker host enroll DEVICE_NAME
token-tracker host revoke DEVICE_NAME_OR_ID
token-tracker host devices
token-tracker service install|start|stop|status
token-tracker collect [--all]
token-tracker sync --once
token-tracker summary [--device DEVICE_NAME_OR_ID] [--all]
token-tracker status
token-tracker --version
```

`collect` always displays only the current machine's local ledger. On a host,
`summary` displays combined usage and adds device totals; `--device` filters by
device name or permanent UUID. Dates are grouped using the machine's local
timezone. Estimated API-equivalent costs use current per-million-token prices from
[`https://models.dev/api.json`](https://models.dev/api.json). The catalog is
cached for 24 hours. A newly unrecognized model forces one refresh; if it is
still absent, it is marked unpriced until the cache expires instead of causing
a request on every collection.

## Host and client setup

Configuration lives in `~/.token-tracker/config.toml` with mode `0600`. The
three roles are `standalone`, `host`, and `client`.

```sh
# Development host. Setup prompts for name and network address.
token-tracker setup host
token-tracker host enroll laptop
```

Enrollment writes a private JSON file under
`~/.token-tracker/enrollments/`. Transfer that file privately to the client,
then configure it without putting either secret in process arguments:

```sh
token-tracker setup client --non-interactive --enrollment enrollment.json
# Or read the enrollment from stdin:
token-tracker setup client --non-interactive --enrollment - < enrollment.json
```

Install and start the long-running service:

```sh
token-tracker service install
token-tracker service start
token-tracker status
```

The service runs under `launchd` on macOS or a systemd user service on Linux.
It collects and synchronizes immediately at startup, then every five minutes
with configurable jitter. Configuration is reloaded only after an explicit
service restart.

The default BEAM topology uses:

```text
host:    token_tracker_host@ADDRESS
client:  token_tracker_client_DEVICE_ID@ADDRESS (hidden node)
EPMD:    TCP 4369
host distribution: TCP 4789
```

All addresses and ports are configurable. The transport works over any
routable private network; Tailscale is optional. A shared cluster cookie
authenticates Erlang distribution and a separately revocable per-device token
authenticates each synchronization request.

`network.name_mode` is explicitly shared through enrollment. Its default is
`"long"`, which requires IP addresses or fully qualified hostnames. Set it to
`"short"` on the host when every node will use simple hostnames; client
enrollment carries the same choice automatically.

## Synchronization model

The synchronization unit is a session snapshot. Each snapshot contains hourly
rows split by project, agent, provider, model, and intrinsic per-event context
size. A digest change increments the session generation and replaces the
client's durable outbox entry. The host transactionally replaces only that
device/session when it accepts a newer generation.

- Acknowledgements are per session, so valid work clears even if another
  session is rejected.
- Duplicate and stale deliveries are acknowledged harmlessly.
- Failed deliveries remain in the outbox and retry on the next cycle.
- Messages are capped at 50 sessions and 1 MiB by default and split as needed.
- The host retains synchronized sessions indefinitely. Missing local files do
  not send deletions.

Relevant configuration defaults:

```toml
[sync]
interval_seconds = 300
jitter_seconds = 10
batch_max_sessions = 50
batch_max_bytes = 1048576
call_timeout_ms = 15000
```

SQLite triggers maintain a durable dirty-session queue whenever usage events
are inserted, changed, or removed. After the initial snapshot build, each
service cycle reconciles only queued sessions rather than rescanning the entire
usage ledger.

## Session data model

| Table | Purpose | Important fields |
|---|---|---|
| `devices` | Host registry and per-device authentication | Permanent device ID, display name, BEAM node name, token hash, local/revoked state, last seen/sync |
| `session_snapshots` | Current authoritative revision for each device/session | Device and hashed session key, agent, generation, digest, start/last activity, quality, received time |
| `session_usage_hourly` | Graph-ready usage contained by a snapshot | UTC hour, device/session, project, agent, provider, model, intrinsic context key, five token counters, one normalized session start |
| `session_outbox` | Client-side durable, coalescing delivery queue | Session/generation/digest, encoded snapshot, byte size, attempt count, last attempt/error |
| `session_reconcile_queue` | Durable incremental local rebuild queue | Session key and version, maintained by SQLite event insert/update/delete triggers |
| `runtime_state` | Small operational checkpoints | Reconciliation initialization, last collection/sync, last synchronization error |

The hourly dimensions directly support 1-day, 1-week, and 1-month charts plus
device, project, agent, and model grouping/filtering. Additive overall and
start-period session totals use the single normalized `session_starts` marker.
Session counts inside a device, project, agent, or model filter use distinct
`(device_id, session_key)` pairs, so sessions spanning multiple dimensions are
counted correctly. API-equivalent cost remains dynamic: each event is
aggregated only with events having the same intrinsic context-token size, and
reports apply the current models.dev thresholds and rates. Historical
snapshots therefore remain correctly repriceable even when the pricing catalog
was unavailable during collection or changes later.

## Checks

```sh
mix format --check-formatted
mix test
mix check
```
