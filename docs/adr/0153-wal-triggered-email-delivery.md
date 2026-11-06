# ADR-0153: WAL-triggered email delivery

- Status: Accepted; amends [ADR-0074](0074-transactional-email-outbox.md)
- Date: 2026-11-06
- Related issue: [#1630](https://github.com/AiHub-Ecosystem/aihub-be/issues/1630)

## Context

The email delivery request is already committed in the same transaction as its
account, credential, or invitation mutation. Periodic claims of every queued
request add repeated table work. The evaluation in
[`zero-table-outbox-evaluation.md`](../operations/zero-table-outbox-evaluation.md)
recommended retaining that scan until its generic performance triggers were
measured. Issue #1630 explicitly authorizes a WAL dispatch path for this email
outbox; it does not introduce a generic event bus or change other outboxes.

## Decision

The email request writer emits a transactional `pg_logical_emit_message` with
the request ID in the same PostgreSQL transaction as the durable row. The
payload contains no address, token, ciphertext, or message body. A single
logical replication slot consumes these messages through PostgreSQL's
`pgoutput` plugin. Requests are claimed only from the IDs in a committed WAL
batch. The existing claim query still applies priority and fairness within
that batch, and the poller preserves bounded retries, stable provider
idempotency, credential checks, cancellation, pacing, the shared budget, and
terminal reporting.

The slot acknowledges a commit only after every referenced request has reached
a durable terminal state. A retry leaves its commit unacknowledged. The
consumer continues to process later commits, but advances the slot only across
the contiguous prefix whose outcomes are durable. On restart, PostgreSQL
replays unacknowledged messages. The stable request ID, lease, terminal row,
and provider idempotency key suppress duplicate sends while Resend retains the
key for 24 hours; an ambiguous outcome replayed after that window can duplicate
a send, as recorded in ADR-0122. A one-time queued-row
reconciliation after a replication connection starts covers requests that
predate a newly created or recovered slot. No periodic queued-row claim drives
delivery.

`email_delivery_requests` remains the source of status, attempt evidence,
operator investigation, and retry timing. The existing scheduled maintenance
still cancels stale credentials, fails exhausted attempts, reports terminal
failures, and maintains metrics; it does not claim queued requests for
dispatch.

## Operations

The logical consumer uses a dedicated direct PostgreSQL URL, never PgBouncer.
The database runs with `wal_level=logical`, a least-privilege `REPLICATION`
login, an empty publication used for message decoding, one named logical slot,
and a bounded `max_slot_wal_keep_size`. Alert when the health read fails, the
slot is inactive or invalid, or less than 256 MiB of the 1 GiB slot budget
remains. Slot loss is an
operator recovery: restore the publication and slot, then let startup
reconciliation dispatch durable queued rows before acknowledging new WAL.
Never advance or drop a slot to clear retained WAL without that reconciliation.

The email-outbox runbook documents setup, rollout, restart, and lost-slot
recovery. Logical WAL is part of PostgreSQL availability: if the consumer stops,
the slot retains WAL until it resumes or reaches the configured cap.
