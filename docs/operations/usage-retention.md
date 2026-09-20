# Usage retention

This runbook describes the nightly operator command that prunes durable
`usage_records` evidence after the agreed 13-calendar-month retention window.
The table remains the billing and audit source of truth inside that window;
Redis quota counters and idempotency records are outside this command.

## Schedule and scope

Run the command at **02:30 UTC**, after the 02:00 UTC quota reconciliation. Use
one cron owner and invoke it once for each deployment database:

```sh
docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T app pnpm cli usage:prune

docker compose --env-file .env.production \
  -f docker-compose.production.yml \
  --profile sandbox exec -T app-sandbox pnpm cli usage:prune
```

Each invocation loads its selected database URL from the Vault Agent connection
snapshot. Production and sandbox failures are independent; alert on a non-zero
exit and on a missed run for either container.

## Retention boundary

One run captures a UTC `retention_cutoff` by subtracting 13 calendar months
from its start instant. Month-end subtraction clamps to the last valid day of
the target month. Only rows with:

```sql
created_at < :retention_cutoff
```

are eligible. Rows exactly at the cutoff and future-dated rows remain. All
outcomes are subject to the same boundary; there is no billable/success
exception.

## Safety and batching

Before the first production run:

1. Create and verify a `pg_dump -Fc` backup using the deployment backup runbook.
2. Run a read-only count for the chosen cutoff:

   ```sql
   SELECT count(*)
   FROM usage_records
   WHERE created_at < :retention_cutoff;
   ```

3. Run the command manually in each application container and retain its
   JSONL output before enabling the nightly schedule.

The command has no dry-run, confirmation flag, or backup side effect. It
deletes at most 1,000 rows per transaction using `(created_at, request_id)` as
the keyset order and `FOR UPDATE SKIP LOCKED` for accidental concurrent runs.
There is no distributed lock. A process termination rolls back only the open
batch; previously committed batches remain deleted and a rerun is safe.

## Output and failure handling

Successful output is stable JSONL:

```json
{"event":"usage_prune_started","started_at":"2026-09-18T02:30:00.000Z","cutoff":"2025-08-18T02:30:00.000Z","batch_size":1000}
{"event":"usage_prune_completed","completed_at":"2026-09-18T02:30:04.000Z","cutoff":"2025-08-18T02:30:00.000Z","batch_size":1000,"batches":2,"deleted":1234,"status":"completed"}
```

An operational failure emits a `usage_prune_failed` event with the cutoff,
batch count, deleted count, status, and a stable safe error code. It never
prints connection strings, SQL, raw Postgres errors, API keys, assertions, or
request data.

| Exit code | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `0`       | Completed, including an empty table or zero eligible rows |
| `1`       | Missing configuration, Postgres failure, or partial run   |
| `2`       | Invalid command arguments                                 |

Fix the dependency and rerun the same container command. Do not manually
rewrite Redis counters or invoke `idempotency:cleanup` as part of this
recovery; those are separate maintenance responsibilities.

## Restore and verification

Restore testing remains a separate operator exercise. Keep the backup until
the post-run checks and restore rehearsal policy are satisfied. Verify that:

- the JSONL completion event exists for each deployment database;
- the exit status is zero;
- a follow-up count finds no rows older than the captured cutoff;
- recent records and the quota reconciliation command remain unaffected.

See [quota reconciliation](./quota-reconciliation.md) for the adjacent 02:00
UTC maintenance job and [the VPS deployment backup runbook](./deploy-vps.md)
for backup and restore handling.
