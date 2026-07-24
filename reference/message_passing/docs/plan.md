# High-level message-passing plan

## 0. Establish the smallest message

Status: scaffolded, not run.

- One root process.
- One registered leaf process.
- One referenced request and one current-state response.
- A short timeout with no delivery recovery.
- The next poll is the retry.

Exit condition: two local IEx nodes demonstrate success, timeout while the leaf
is stopped, and automatic recovery after it restarts.

## 1. Cross one Tailscale link

- Install matching Erlang/Elixir versions on one stable root machine and one
  leaf machine.
- Use long node names based on resolvable Tailscale MagicDNS names.
- Pin one distribution port and scope Tailscale ACL access to the two peers.
- Keep the cookie out of arguments and logs.
- Confirm request, response, timeout, node-down, and reconnection behavior.

Exit condition: the root can repeatedly replace its view of the leaf without
manual reconnection after an ordinary network interruption.

## 2. Make the node reusable

- Define a capability behaviour for state providers and commands.
- Supervise each capability independently.
- Add a root registry keyed by stable device identity.
- Store only the last successful snapshot and its observation time.
- Expose node presence separately from application state.

Exit condition: adding a new state provider does not change the root poller or
transport protocol.

## 3. Add a real use case

Start with a reversible command, likely:

- run `ctoken collect --once`;
- report agent/job presence;
- run a read-only machine health snapshot.

The command result should be reference-correlated and time-bounded. Do not add a
durable job queue until a use case actually requires one.

Exit condition: the experiment saves a real manual step on at least two
machines.

## 4. Decide the network product

Evaluate:

- direct Erlang distribution versus Phoenix Channels;
- root-and-leaves versus peer mesh;
- visible versus hidden nodes;
- tailnet-only distribution versus TLS distribution;
- static target configuration versus discovery;
- one shared application versus host/node releases.

Exit condition: write down the smallest stable platform contract before moving
any production system onto it.
