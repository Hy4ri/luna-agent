# Analytics v2

Analytics uses a separate `analytics.db` beside `luna.db` (normally `/.luna/analytics.db`). SQLite uses WAL and the database file has mode `0600`.

## Storage and freshness

The index stores session titles, metadata, usage ledgers and event measurements. It does not copy transcripts, tool arguments or tool results. Error reasons are sanitized and truncated.

Ordinary appends scan only new owned entries. Structural changes rebuild the affected session. Durable checkpoints let a restart reuse unchanged sessions. Status and activity are stored rather than read through the harness for every dashboard request. SQL aggregates use indexed scalar columns; a bounded aggregation cache expires after index writes. Paging, search and sorting still apply to each request.

Deletion first flushes the session under the maintenance barrier. If preservation fails, deletion fails too. The index then keeps a tombstone with the title and recorded numbers. Sessions deleted before indexing cannot be recovered. Removing `analytics.db` rebuilds retained sessions but permanently loses deleted-session history.

Commits update dirty sessions after a short debounce. Authenticated SSE sends `analytics_changed`; the mounted, visible dashboard refetches without polling. Saved results can appear during restart catch-up; `performance.indexedAt` reports index freshness.

## Views

The default range is all time. Include deleted defaults to on; this is a product default, not an explicit user preference. Session rows show a Deleted badge.

| Tab | Main data |
|---|---|
| Overview | Scope totals, recorded cost/token series, sessions |
| Models | Model usage, cache, cost components and optional usage counters in the drawer |
| Tools | Direct and codemode calls, nested tools, skill uses, errors and durations |
| Sessions | Titles, project, worker, status, usage; metadata and subtree usage in the drawer |
| Delegation | Child/fork relations and cross-session messages |
| Reliability | Response errors, aborts, sanitized reasons, requested/served model and thinking levels |
| Speed | Measured model/tool latency, p50/p95, output tokens per second and turn wall time |
| Context | Compactions, system/thinking sizes and cache usage |
| Workflow | Latest goals/todos/vision/upload counters; recorded waits, model changes, undo and quota events |
| Projects | Project/worker/cwd usage |

The hash stores the tab, filters and drawer: `#analytics/models?provider=anthropic&open=model:anthropic%2Fexample`. Back closes the drawer. Tables become cards below 760px. A finite time window enables comparison with the previous equal-length window, including percentage changes. A zero baseline cannot produce a percentage change and displays as unavailable.

## HTTP API

Existing `/v1/analytics` and `/v1/analytics/sessions` URLs keep their legacy active-session response shapes through the persistent-store adapter.

| GET path | Response |
|---|---|
| `/v1/analytics/v2/filters` | Project, model, provider, worker and cwd options |
| `/v1/analytics/v2/:tab` | Summary, series, primary table, supplemental tables, notes and query timing |
| `/v1/analytics/v2/:tab/:kind/:id` | Scoped entity drawer or 404 |
| `/v1/analytics/v2/:tab/export?format=csv\|json` | All matching primary-table rows, without pagination |

All routes use normal API authentication and `Cache-Control: no-store`. Tab queries also return `Server-Timing`. Exports cover the primary table, not every supplemental table, chart or drawer. JSON exports are arrays; CSV uses the primary table's columns.

| Parameter | Default / validation |
|---|---|
| `from`, `to` | Optional epoch milliseconds; lower bound inclusive, upper bound exclusive; `from < to` |
| `project` | Repeated integer IDs; at most 100 |
| `model`, `provider`, `worker`, `cwd` | Repeated strings; at most 100 values per key |
| `includeDeleted` | `true`; accepts `true` or `false` |
| `source` | Optional `direct` or `codemode` |
| `compare` | `false`; comparison requires both time bounds |
| `search` | Empty; at most 512 characters; searches table rows |
| `sort` | Optional allowed column key, optionally followed by `:asc` or `:desc` |
| `page` | `0`; nonnegative integer |
| `limit` | `20`; integer from 1 to 100 |

## Measurement boundaries

- All-time unfiltered usage uses full session/model ledgers, including compaction costs. Date, model/provider and tool-source filters use matching response facts. Undated costs cannot be attributed to a time bucket. Notes distinguish these totals.
- Project, worker, cwd and workflow document counters describe the latest snapshot, not historical attribution or completion times. Session drawers label their unscoped latest ledger separately from the scoped subtree rollup.
- Missing timestamps, response timing and optional token counters remain unavailable. Latency is recorded total duration, not time to first token. Temporal charts omit undated events and show UTC buckets.
- New question and session-status pauses record metadata-only `luna.analytics.wait` start/end events. Replays do not reopen completed waits. Historical generic wait durations remain unavailable. Quota reset timestamps are planned reset times, not measured waiting time.
- Model costs and tool-attributed ledgers overlap; they are not additive expenses. Delegation rollups deduplicate child/fork cycles and respect the selected scope.

## Verification and performance

Store/query/source/service/HTTP/wait tests cover replay, tail parsing, deletion retention, filtered accounting, cache invalidation, exports and SSE. Browser checks used a separate temporary harness with recorded synthetic entries and no model calls: all ten tabs, filters, comparison, drawer/Back, CSV/JSON downloads, live updates, keyboard navigation and 1440px/390px layouts. The application currently uses dark tokens under both OS color preferences; this change does not add a light theme.

Measurements on ARM64 used 420 sessions and 63,457 entries. The source database was read-only in one snapshot transaction; the benchmark wrote a separate temporary analytics index. Initial indexing took 28.79s. A no-change pass across all 420 sessions took 2.79s and parsed zero entries. Normal live updates process dirty IDs rather than repeat that full pass.

The final query sample used the same saved index, all-time defaults and seven queries per tab. These are function timings, not HTTP or browser render timings. The first query can populate shared aggregates; the median includes subsequent unchanged-index queries. Writes invalidate the aggregation cache, so warm medians do not describe the first request after an update.

| Tab | First query (ms) | Median (ms) |
|---|---:|---:|
| Overview | 122.20 | 0.286 |
| Models | 129.28 | 0.080 |
| Tools | 100.87 | 0.087 |
| Sessions | 58.68 | 0.216 |
| Delegation | 10.01 | 0.224 |
| Reliability | 279.96 | 0.559 |
| Speed | 158.55 | 0.054 |
| Context | 286.34 | 6.899 |
| Workflow | 9.41 | 0.162 |
| Projects | 59.27 | 0.055 |
