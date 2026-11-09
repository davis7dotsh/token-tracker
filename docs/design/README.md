# Usage design studies

Two isolated, interactive alternatives for the same dashboard. Open `usage/overview.html` or `usage/compare.html` in a browser. Both use the same deterministic fictional session history: no configuration, collectors, credentials, RPC or live usage are involved.

| Study           | Where the filters live                                                  | How to explore                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usage overview  | A single searchable scope bar with removable chips and the time window. | Start with the device stack. Select a segment to inspect the bucket, then isolate its device or select a contributing model or project.                            |
| Comparison desk | A persistent scope rail on desktop, a sticky facet shelf on phones.     | Compare aligned series on a shared scale, or switch to per-series scales to see the shape of smaller workloads. Inspect any point or row before applying a filter. |

Both pages use a single flat canvas. Metrics, charts, the legend, the scope rail and session rows have no cards. Lines separate sections; only a temporary picker or inspector floats above the page. Neither nests another surface.

Opening an inspector never changes the dashboard. Its Include/Remove action uses the same multi-select rule as the scope rail; Only explicitly isolates a value. The palette stages edits until Apply. Checkboxes include multiple values (OR within one dimension, AND across dimensions). Drilling isolates one series, carries other dimensions forward, and switches to the next useful split. Back undoes the drill; direct URLs reproduce the scope. The time window covers the fictional period ending November 8, 2026 UTC. Cost uses illustrative rates, not billing data.

These static studies remain fictional references. The working implementation lives at `/` and `/?view=compare`. It uses the tracker RPC, including device series in both daily and hourly buckets, rather than inferring a timeline from fleet-wide totals.
