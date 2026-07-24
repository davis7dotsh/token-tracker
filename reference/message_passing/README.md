# Message-Passing Experiment Reference

A small place to test a broader idea: a root node periodically asks other
machines for their current state, and those machines answer with whatever is
true at that moment.

The request and reply are intentionally disposable. If either is lost, the root
keeps its last successful view and asks again later. This is a control-plane
experiment, not a durable event pipeline and not a rewrite of Columbia's Token
Tracker.

## What is here

- `StateSource` is a registered process on every leaf node.
- `Poller` runs on the root node and sends each leaf a referenced state request.
- A successful reply replaces the root's cached snapshot for that node.
- A timeout is logged and discarded. The next scheduled request is the retry.
- The snapshot is deliberately harmless: node name, observation time, uptime,
  process count, and BEAM memory.

See [the research](docs/research.md), [high-level plan](docs/plan.md), and
[message-flow visualization](docs/architecture.md).

## Local hello world

Elixir and Erlang/OTP are required.

Start a leaf:

```sh
TTEX_ROLE=leaf \
  iex --sname leaf --cookie local-experiment-only -S mix
```

In a second terminal, use the leaf node name printed by IEx:

```sh
TTEX_ROLE=root \
TTEX_TARGETS="leaf@YOUR-SHORT-HOSTNAME" \
  iex --sname root --cookie local-experiment-only -S mix
```

The root requests state immediately and every five seconds. Stop the leaf to
observe harmless timeouts; restart it with the same node name to see replies
resume.

## Tailscale shape

Use long names on different machines:

```sh
TTEX_ROLE=leaf \
  iex --name leaf@DEVICE.TAILNET.ts.net --cookie REPLACE_ME -S mix

TTEX_ROLE=root \
TTEX_TARGETS="leaf@DEVICE.TAILNET.ts.net" \
  iex --name root@ROOT.TAILNET.ts.net --cookie REPLACE_ME -S mix
```

For a real tailnet test, do not put the cookie in shell history. Use a
permission-restricted cookie file or release secret, restrict EPMD and the
pinned distribution port with Tailscale ACLs, and evaluate TLS distribution.
The example uses command-line cookies only to make the local two-terminal hello
world obvious.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `TTEX_ROLE` | `leaf` | `leaf`, `root`, or `both` |
| `TTEX_TARGETS` | empty | Comma-separated long or short node names |
| `TTEX_POLL_INTERVAL_MS` | `5000` | Time between current-state requests |
| `TTEX_REQUEST_TIMEOUT_MS` | `1500` | Time before a missing reply is forgotten |

## Checks

```sh
mix format --check-formatted
mix test
```
