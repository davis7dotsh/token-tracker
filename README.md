# Token Tracker

A local, single-user CLI that imports Codex token history into a private SQLite
ledger and prints a usage summary. The first collection scans all existing
history. Later collections skip unchanged files using durable checkpoints.

The active application is intentionally local-only. The earlier distributed
Elixir message-passing experiment is preserved under
[`reference/message_passing`](reference/message_passing/README.md) for the next
phase of the project.

## Data

Token Tracker reads:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`

It stores only timestamps, safe project names, model names, token counters,
session counts, and hashed event/session/path identities. It does not store raw
paths, session IDs, prompts, responses, or transcript contents.

State lives under:

```text
~/.token-tracker/
  usage.sqlite3
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
token-tracker collect
token-tracker collect --all
token-tracker collect --home /path/to/token-tracker-home
token-tracker --version
```

The default summary shows today, all time, and the top ten models and projects.
Dates are grouped using the machine's local timezone.

## Checks

```sh
mix format --check-formatted
mix test
mix check
```
