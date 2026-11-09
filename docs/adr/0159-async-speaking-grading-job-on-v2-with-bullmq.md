# ADR-0159: The async Speaking grading job lives on `/v2`, runs on BullMQ, and never re-dispatches

- Status: Accepted — approved by AIHUB owner @lengocanh2005it in [#1718](https://github.com/AiHub-Ecosystem/aihub-be/issues/1718) on 2026-11-08.
- Amends: [ADR-0014](0014-ai-speaking-d2-contract-boundary.md) (the planned `POST /v1/speaking/grade`), [ADR-0074](0074-transactional-email-outbox.md) (Redis is not used as a queue), [ADR-0129](0129-public-route-and-response-convention.md) (a graded operation ends in `/grade`)
- Related: [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0070](0070-speaking-audio-upload-intent-and-retention.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md), [#1051](https://github.com/AiHub-Ecosystem/aihub-be/issues/1051), [#1752](https://github.com/AiHub-Ecosystem/aihub-be/issues/1752)

## Context

ADR-0014 and the request-lifecycle spec (`02-request-lifecycle.md`) planned an async `POST /v1/speaking/grade` backed by a Postgres `jobs` table and a BullMQ execution queue. Both predate ADR-0138, which moved Speaking to the provider's v2.4 contract on public `/v2`; ADR-0127 retires `/v1` after its sunset window. A job added on `/v1` would call a provider contract that is being replaced and die with `/v1`.

ADR-0074 chose Postgres polling for the email outbox and said Redis is not used as a queue because it is ephemeral protection/cache state. ADR-0129 requires a graded operation to end in `/grade`. The Speaking AI Service has no idempotency key: a second call grades and bills again and may return a second `response_id`.

## Decision

1. **Placement.** The job serves question grading on `/v2` only: `POST /v2/ielts/speaking/grading-jobs` answers `202 { data: { job_id, status: "queued" } }`, and `GET /v2/ielts/speaking/grading-jobs/{job_id}` answers `200` with `status` (`queued`, `running`, `succeeded`, `failed`), `result` (the Speaking v2 question result, with `response_id`), or `error` (`{ code, message, retryable }`). The worker calls the provider's v2 question grading. No `/v1` route is added; ADR-0014's `/v1/speaking/grade` is withdrawn. Part and test aggregation stay synchronous.
2. **Route naming.** Creating a job is a create on the `grading-jobs` collection, not a graded call, so it does not end in `/grade`. ADR-0129's `/grade` rule binds synchronous graded calls; this record is the decision that names the collection.
3. **Queue.** The job record in Postgres is the source of truth. BullMQ is the execution queue only, carrying the `job_id` and nothing else. This is a scoped exception to ADR-0074: no job state lives only in Redis, so losing Redis loses the wake-up signal, never an accepted job. Production and Sandbox use separate queues.
4. **Submit.** Submit runs Graded admission in ADR-0057 order; a refusal creates no job. The monthly quota check counts the Organization's queued and running job reservations, plus succeeded jobs whose quota reservation remains active until the metering finalizer completes, on top of recorded usage. Active reservations count whatever month the job was created in, because a job is metered in the month it dispatches, and admission serializes per Organization rather than per month so submissions on either side of a month boundary see each other. Sandbox reserves one dispatch keyed by the `job_id`. The Audio asset must match the caller's Organization, End-User ID, and Environment and be inside its retention deadline, else `NOT_FOUND`. An optional `Idempotency-Key` replays the original `202`. Submit commits the record as `queued`, then enqueues with BullMQ's job ID set to the `job_id`; a failed enqueue still answers `202`.
5. **Worker.** The worker claims a job with one conditional update from `queued` to `running` under a bounded lease; a claim that changes no row is dropped, so a duplicate delivery never grades twice. It acquires the Organization's Concurrency permit (delaying the job without one), re-checks the asset's retention, records that dispatch started, calls the AI Service, then persists the result, records the `response_id` in the Speaking v2 result-ownership store, and meters through the shared finalizer in the month of dispatch.
6. **Recovery.** Before the dispatch mark, a crash returns the job to `queued`. After it, the job ends `failed` with the retryable `DISPATCH_INTERRUPTED` and is never re-dispatched. BullMQ runs one attempt with no stalled-job re-runs and removes jobs on completion and failure, so every retry is decided from Postgres and a re-enqueue under the same job ID is accepted. One sweep every 30 seconds re-enqueues jobs `queued` over 60 seconds, returns expired pre-dispatch leases to `queued`, ends stale dispatched jobs as `DISPATCH_INTERRUPTED`, ends jobs `queued` over 15 minutes as `JOB_EXPIRED` (releasing any Sandbox reservation), releases the quota reservation of a `succeeded` job whose metering handoff did not release it within 2 minutes, and deletes jobs older than 30 days. Each step is a conditional statement, so two deployment slots may run it at once.
7. **Placement of the worker.** The worker and sweep run inside the application process.

## Consequences

- The request-lifecycle spec's `POST /v1/speaking/grade`, `GET /v1/jobs/{job_id}`, and separate reconciler are superseded by this record; the Postgres-is-source-of-truth rule it states still holds.
- AIHUB now has two queue mechanisms: Postgres polling for email and BullMQ for Speaking jobs. A future queue needs its own choice rather than inheriting either.
- The runtime Redis role needs permissions for the queue's keys and scripts before the release that enables the worker. That is a release step on the production host, separate from merging the implementation.
- A job interrupted after dispatch costs the integrator one resubmit and may already have been billed by the provider; that is the price of never grading twice.
- Running the worker in-process ties grading throughput to the API's process. Moving it to its own process is the upgrade when worker load measurably affects API latency.
- Multi-step pipelines (batch grading with webhooks, async full tests) are evaluated separately in #1051 and #1752.

## Considered options

- **Graphile Worker** (Postgres-only, transactional `add_job`): removes the dual write and the ADR-0074 exception, but the open-source version leaves a crashed worker's job locked for up to four hours and has a smaller user base. Rejected by owner preference for BullMQ's maturity.
- **pg-boss** (Postgres-only, with heartbeats): a middle option; rejected for the same reason.
- **Postgres `SKIP LOCKED` with a lease, as in the email outbox:** no new dependency, but a second hand-rolled queue.
- **Temporal or DBOS durable workflows:** the job has one dispatch step, so their checkpointing buys little now; deferred to #1051 and #1752.
- **A new `/v1/speaking/grade` on the provider's v1 contract:** rejected because it would be retired with `/v1`.
- **`Prefer: respond-async` on the synchronous path, or `.../questions/async/grade`:** rejected for giving one route two response shapes, or for an awkward path that only satisfies the letter of ADR-0129.
- **At-least-once re-dispatch:** rejected because the provider has no idempotency key, so a retry could grade and bill twice.
