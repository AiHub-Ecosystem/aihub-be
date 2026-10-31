# PostgreSQL query-plan baseline

Use this baseline to record whether AIHUB's hot control-plane queries continue
to use their intended indexes as tables grow. It measures PostgreSQL plans and
relation sizes. It does not add indexes, tune autovacuum, or set a Production
rate limit.

## Run the baseline

The runner requires the local PostgreSQL service and its database-lane marker.
It creates a unique disposable database on the local server, applies every
checked-in migration, seeds synthetic rows, analyzes the tables, runs the plans,
and drops only the database it created. Retention and idempotency cleanup plans
run inside transactions that are rolled back.

From PowerShell:

```powershell
docker compose up -d --wait postgres
$env:AIHUB_POSTGRES_BASELINE = '1'
bun run benchmark:postgres-plans
Remove-Item Env:AIHUB_POSTGRES_BASELINE
```

The command fails closed unless `DB_LANE_ADMIN_URL` names the local `aihub`
database on port 5432, PostgreSQL is version 16, and
`aihub.test_lane_marker=aihub_db_lane_v1`. It takes the same advisory lock as
the database test lanes. The seed is isolated from the existing `aihub` rows;
do not point it at a shared or remote server.

The command overwrites
[`postgres-query-plan-baseline-results.md`](postgres-query-plan-baseline-results.md)
with the latest measured plans and table/index sizes. Commit the generated
report with the query or schema change that prompted the run.

## Workload and query set

The disposable database contains 100 Organizations, 100,000 API keys, 100,000
Organization memberships, 1,000,000 usage records, 100,000 idempotency records,
100,000 dispatch attempts, and 100,000 Sandbox reservations. Usage and dispatch
timestamps span 210 days; the retention statements use a 30-day cutoff and a
500-row batch. Usage and dispatch rows are inserted oldest-to-newest to preserve
the physical correlation relevant to BRIN plans. The runner records exact row
counts, heap/index/total relation sizes, and `created_at` correlation after
`ANALYZE`.

The plans cover API-key hash lookup; Organization primary-key and membership
reads; idempotency conflict insert, reservation and completed-replay reads;
Sandbox allowance and reservation-count reads; request/token metering, usage
completeness, and quota aggregates; the monthly billing aggregate; and usage,
dispatch-attempt, and idempotency retention statements. The raw SQL plans use exported repository
query constants. Sandbox ORM reads use the same mapped columns and predicates.

Each report records the actual plan nodes, projected columns, index
conditions, indexes observed, sequential scans and their actual row counts,
execution time, heap fetches, and shared/temp buffer counts. Compare projected
columns with the repository row mappers to spot unused wide or TOASTed values.
Index scans that fetch heap columns are visible beside their output fields for
covering-index review; the runner does not change query plans or add indexes to
make the report appear green.

The downstream HTTP client keeps one Undici pool per origin with a 5-minute
keep-alive timeout and a 10-minute maximum. The existing capacity benchmark
records `aihub_downstream_pool_queued` as its downstream queue peak; it does not
count socket reuse or fresh handshakes. The SQL baseline does not send provider
requests and does not claim a runtime reuse rate.

## Interpretation and cadence

Rerun after changing a listed query, table, or index, and at least quarterly.
Compare row counts and table/index sizes along with the plan. A query that scans
a substantial share of a table may correctly use a sequential scan; use the
recorded selectivity and buffers before proposing an index.

This synthetic local baseline is not an exact Production workload or a
Production rate limit. Production `pg_stat_statements` status and its privacy
gate are documented in the
[observability runbook](aihub-observability.md#statement-statistics-and-privacy-gate).
As of 2026-10-16, version 1.10 was available but not installed in any
connectable AIHUB database. #299 tracks queryable slow-statement evidence and is
the precondition for per-statement means; this baseline does not restart or
change the shared Production cluster.
