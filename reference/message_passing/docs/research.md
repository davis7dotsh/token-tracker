# Message-passing research notes

## Working premise

The useful abstraction is not a durable queue. It is a network of supervised
processes that can ask each other what is true now.

A root sends:

```elixir
{:state_request, reply_to, reference}
```

A leaf answers:

```elixir
{:state_response, reference, Node.self(), current_state}
```

If the distribution connection drops during either signal, nothing is repaired.
The root times out, retains its last successful snapshot, and asks again on the
next interval. That matches state observation better than event replication:
new state supersedes old state.

## Why Elixir/OTP fits

- Elixir processes remain addressable across nodes; sending to a remote PID or
  `{registered_name, node}` uses the same message model as local processes.
- Supervisors give each device capability an explicit failure boundary.
- Monitors and node-up/node-down events can make presence a first-class signal.
- A long-lived node can receive commands immediately instead of relying on
  cron, launchd, or systemd timers for every action.
- Mix releases can package the application and Erlang runtime for machines that
  do not have Elixir installed.

## Distribution facts

- Long and short node names cannot communicate with each other. A tailnet test
  should use long names with resolvable MagicDNS hosts.
- Registered names are local to their node, so a remote registered address is
  `{TokenTrackerElixirExperiment.StateSource, target_node}`.
- EPMD normally listens on TCP `4369` and maps a node name to its distribution
  port. A real deployment should pin the distribution port range.
- Connections are transitive by default. A root-and-leaves topology may prefer
  explicit connections or hidden nodes rather than an accidental full mesh.
- Cookies authorize node connections but do not make default Erlang
  distribution cryptographically secure. Tailnet ACLs reduce exposure; TLS
  distribution adds transport authentication and encryption.
- Signals can be lost if the distribution channel goes down. This experiment
  treats that as expected behavior.

## Boundary with Columbia Token Tracker

Columbia's existing collector protects a different invariant: locally retained
history is eventually delivered as aggregate replacements. Its SQLite ledger,
generations, acknowledgements, and durable outbox are valuable when the history
matters.

This experiment tests the complementary control-plane model:

- current state instead of event history;
- replacement instead of replay;
- retry-by-repolling instead of delivery recovery;
- supervision and orchestration instead of scheduled one-shot processes.

If the experiment later controls Token Tracker, an early integration can simply
ask a leaf to run `ctoken collect --once`. The established Go collector can
continue owning parsing, privacy, and durable ingestion while Elixir owns
presence, commands, and live status.

## Candidate uses beyond token tracking

- Ask every workstation what agents or long-running jobs are active.
- Request a fresh backup, archive, indexing, or health pass.
- Discover device capabilities and route a task to an appropriate machine.
- Query local model availability and load.
- Observe storage, battery, thermal, or service state.
- Coordinate media movement without centralizing machine-specific state.
- Build a shared control surface for agents running across the tailnet.

The common contract is small: request current state, request an action, receive
an acknowledgement or time out, then try again when appropriate.

## Primary sources

- [Elixir: Configuration and distribution](https://hexdocs.pm/elixir/config-and-distribution.html)
- [Erlang/OTP: Distributed Erlang](https://www.erlang.org/docs/28/system/distributed.html)
- [Erlang/OTP: Processes and signal delivery](https://www.erlang.org/doc/system/ref_man_processes.html)
- [Erlang/OTP: Using TLS for Erlang distribution](https://www.erlang.org/docs/26/apps/ssl/ssl_distribution.html)
- [Mix: Releases](https://mix.hexdocs.pm/Mix.Tasks.Release.html)
