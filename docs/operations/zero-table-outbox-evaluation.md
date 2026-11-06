# Zero-table outbox evaluation

Status: evaluation only. This report does not change a production path.

## Recommendation

Keep the current durable table outbox unless one of the measured triggers in
[#1596](https://github.com/AiHub-Ecosystem/aihub-be/issues/1596) is observed:

- outbox dead tuples exceed 30% between vacuum passes under sustained 50 RPS;
- relay polling latency exceeds 1,000 ms at P95 during concurrent grading; or
- outbox-attributed WAL exceeds 3 MB/s during peak exam periods.

This repo currently has `email_delivery_requests`, a durable email delivery
queue described by [ADR-0074](../adr/0074-transactional-email-outbox.md). It
does not have the generic `outbox_events` table described in #1596. The issue
also cites #1215 as the existing polling relay, but #1215 is a separate
`LISTEN/NOTIFY` cache-invalidation evaluation. Treat the polling table below as
a proposed generic baseline; neither issue is a deployed general event bus.
The accepted email outbox has delivery state, bounded retry, cancellation and
operator evidence that a WAL message alone does not provide.

## Comparison

| Concern                  | Table outbox with polling                                                                              | `pg_logical_emit_message` plus logical decoding                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomicity                | Business mutation and outbox row commit or roll back together.                                         | `pg_logical_emit_message(true, ...)` is emitted only with the containing transaction.                                                                                                                                                             |
| Durability and recovery  | Rows remain queryable until the relay records a terminal state; operators can inspect and repair them. | The replication slot replays from its confirmed LSN; a crash can replay recent messages, so consumers must be idempotent.                                                                                                                         |
| Work on producer         | Heap/index insert plus relay claim/update/delete, with vacuum reclaiming dead tuples.                  | Avoids an event table and its indexes, but the payload still writes to WAL and logical decoding/slot bookkeeping costs CPU and I/O.                                                                                                               |
| Backlog storage          | Table rows and indexes grow until consumed or retained by policy.                                      | An inactive or slow slot retains WAL (and catalog rows); a slot can fill `pg_wal` or become unusable when a configured cap is exceeded.                                                                                                           |
| Consumer interface       | Ordinary SQL `SELECT ... FOR UPDATE SKIP LOCKED`; simple to inspect and operate.                       | Streaming replication protocol or SQL decoding functions; a regular `pg` query connection is not a streaming decoder. `pgoutput` requires the `messages` option; `test_decoding` is useful for a local prototype, not a production wire contract. |
| Replay and delivery      | At-least-once relay plus durable attempt/idempotency records.                                          | At-least-once replay around consumer checkpoint and publish; use stable event IDs and the existing durable idempotency boundary (#1005).                                                                                                          |
| PostgreSQL configuration | Works with the current local PostgreSQL 16 Compose setup.                                              | Requires `wal_level=logical`, slot capacity, WAL sender capacity, a least-privilege replication role, slot monitoring and additional WAL budget. Changing `wal_level` requires a restart.                                                         |

`pg_logical_emit_message` stores the message in WAL; “zero-table” means no
relational outbox heap/index, not zero storage or zero WAL. The WAL slot is the
durable backlog and becomes a shared database availability risk if its consumer
stops.

## Synthetic performance run

The runner compares one transaction per event at a target of 1,000 events/s.
The table path inserts synthetic payloads and drains in batches of 128 with
`FOR UPDATE SKIP LOCKED`; the logical path emits transactional `aihub_outbox`
messages and consumes them through a `test_decoding` slot. It reports achieved
rate, commit-latency p50/p95/p99, WAL bytes per event, estimated dead tuples and
relation size for the table path, and host-wide CPU samples. Host CPU is a
context signal, not PostgreSQL-only CPU attribution.

Run only against a disposable local PostgreSQL 16 instance. The runner refuses
non-loopback hosts and any database except `aihub_outbox_eval`. It creates a
uniquely named table and replication slot, then removes both on normal exit.
An abrupt kill can leave a slot behind; the recovery steps below cover it.
The same fixed 10,000-event run can be repeated on an isolated GitHub-hosted
Ubuntu runner. Before the dedicated workflow is merged to the default branch,
manually dispatch `CI` with `run_outbox_evaluation=true`; afterward, dispatch
the [Zero-table Outbox Evaluation workflow](../../.github/workflows/zero-table-outbox-evaluation.yml)
directly. Either route uploads runner details and JSON results as a 30-day
artifact and does not connect to or modify a shared database.

```powershell
$env:AIHUB_EVAL_DB_PASSWORD = [guid]::NewGuid().ToString('N')
docker run --rm -d --name aihub-outbox-eval `
  -e "POSTGRES_PASSWORD=$env:AIHUB_EVAL_DB_PASSWORD" -e POSTGRES_DB=aihub_outbox_eval `
  -p 127.0.0.1:5442:5432 postgres:16-alpine `
  -c wal_level=logical -c max_replication_slots=5 -c max_wal_senders=5 `
  -c max_slot_wal_keep_size=256MB

$env:AIHUB_OUTBOX_EVAL_DATABASE_URL = "postgres://postgres:$env:AIHUB_EVAL_DB_PASSWORD@localhost:5442/aihub_outbox_eval"
bun run outbox:evaluate --events 10000 --rate 1000
docker rm -f aihub-outbox-eval
```

Three runs on 2026-11-05 used PostgreSQL 16.15 in an unbounded local Docker
container on a Windows host. Each used 10,000 synthetic events, a 1,000/s target
and 32 producer connections. The table shows medians; host CPU ranged from
98.7% to 100% across both modes.

| Mode            | Committed events/s | Commit P50/P95/P99 (ms) | WAL bytes/s | WAL bytes/event | Dead-tuple estimate | Relation bytes |
| --------------- | -----------------: | ----------------------: | ----------: | --------------: | ------------------: | -------------: |
| Table polling   |                653 |    38.5 / 103.2 / 163.0 |     368,859 |           567.3 |               8,521 |        466,944 |
| Logical message |                581 |    40.1 / 119.0 / 257.2 |     208,245 |           361.1 |                   — |              — |

Neither mode sustained the 1,000/s target on this host. The logical path used
about 36% fewer WAL bytes per event, but committed fewer events/s and had a
higher P99 than table polling. Host CPU was saturated and is not PostgreSQL-only
attribution, so these local measurements do not support an adoption decision.
They satisfy the reproducible synthetic comparison; production triggers still
require metrics from the actual relay under exam workload.

## Compatibility matrix

| Environment                                   | Compatibility                                                              | Configuration and operational gate                                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Compose, PostgreSQL 16                  | Supported for prototype.                                                   | Start a disposable instance with `wal_level=logical`; verify `test_decoding` is installed. The repository's default Compose instance is not configured for logical decoding.                                                                        |
| Self-managed PostgreSQL 16 on the VPS         | Technically supported; not enabled.                                        | Requires a planned restart to set `wal_level=logical`, review `max_replication_slots`/`max_wal_senders`, and allocate bounded WAL headroom. No production setting is changed by this evaluation.                                                    |
| Amazon RDS for PostgreSQL                     | Supported with provider setup.                                             | Set static parameter `rds.logical_replication=1`, apply/reboot, and grant the replication role. Confirm supported decoding plugin, slot metrics, and WAL cap before a pilot.                                                                        |
| Azure Database for PostgreSQL Flexible Server | Supported with provider setup; PostgreSQL 16 HA needs extra failover work. | Set `wal_level=logical`, grant replication privileges, restart, and verify slot recovery on failover. Azure documents that PG16-and-earlier HA does not preserve logical slots by default; evaluate `pg_failover_slots` and `hot_standby_feedback`. |
| Google Cloud SQL for PostgreSQL               | Supported with provider setup.                                             | Enable `cloudsql.logical_decoding`, restart, verify slot privileges and available plugins, and monitor inactive-slot WAL retention.                                                                                                                 |
| Other managed PostgreSQL                      | Unverified.                                                                | Require explicit support for logical decoding messages, logical slots, required privileges, slot/WAL metrics, failover preservation, and bounded retention before adoption.                                                                         |

## Operational runbook

### Monitor every slot

Alert on `active = false`, rising
`pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`, declining `safe_wal_size`,
`wal_status` becoming `unreserved` or `lost`, and sustained
`confirmed_flush_lsn` lag. Inventory slots by owner and purpose; each independent
consumer needs its own slot. Also watch filesystem free space and transaction
ID age because retained catalog rows can delay vacuum.

```sql
SELECT slot_name, plugin, active, restart_lsn, confirmed_flush_lsn,
       wal_status, safe_wal_size,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

Set `max_slot_wal_keep_size` to an owner-approved bound below the free-space
budget after accounting for physical replicas, archive retention and normal WAL
bursts. PostgreSQL enforces this at checkpoints; crossing the limit can
invalidate the slot and lose its unread stream. The cap is a last-resort guard,
not a substitute for a lag alert and on-call response. Do not leave the default
unlimited `-1` without an explicit capacity decision.

### Consumer crash and recovery

1. Restart the consumer with the same slot and durable destination/idempotency
   state. Do not create a replacement slot during a transient outage.
2. Resume from the slot's confirmed position. Expect duplicate delivery after a
   crash; deduplicate by a stable event ID before external effects.
3. If the slot is `lost` or its required WAL is gone, stop the consumer and
   preserve evidence. Reconcile the destination against the source of truth,
   then create a new slot at a documented cutover point. A new slot does not
   recover unread messages.
4. Drop an abandoned slot only after the owner accepts the resulting data-loss
   window. Verify `pg_replication_slots` and free space after cleanup.
5. If a slot is active but not advancing, inspect consumer logs, replication
   connection state and last confirmed LSN. Never clear the slot as the first
   recovery step.

### Rollout gate

Do not replace the email outbox or introduce a generic event bus from this
evaluation alone. First measure one of the stated triggers, then design the
consumer protocol, durable idempotency, event retention/reconciliation, slot
failover and production resource budget as a separate accepted change.

## References

- [PostgreSQL 16: `pg_logical_emit_message`](https://www.postgresql.org/docs/16/functions-admin.html)
- [PostgreSQL 16: logical decoding and replication slots](https://www.postgresql.org/docs/16/logicaldecoding-explanation.html)
- [PostgreSQL 16: `pg_replication_slots`](https://www.postgresql.org/docs/16/view-pg-replication-slots.html)
- [PostgreSQL 16: logical replication protocol messages option](https://www.postgresql.org/docs/16/protocol-logical-replication.html)
- [Amazon RDS logical replication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html)
- [Azure logical decoding and HA slot behavior](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-logical)
- [Google Cloud SQL logical replication](https://docs.cloud.google.com/sql/docs/postgres/replication/configure-logical-replication)
