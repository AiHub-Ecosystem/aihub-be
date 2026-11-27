# ADR-0200: Speaking graded admission precedes the serialization transaction

- Status: Accepted
- Date: 2026-11-27
- Related issue: [#2074](https://github.com/AiHub-Ecosystem/aihub-be/issues/2074), [#1951](https://github.com/AiHub-Ecosystem/aihub-be/issues/1951)
- Builds on: [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0159](0159-async-speaking-grading-job-on-v2-with-bullmq.md), [ADR-0192](0192-gateway-multi-instance-admission.md)

Speaking submit now runs Graded admission with no submit PostgreSQL transaction or per-Organization advisory lock open. In Sandbox, the Sandbox dispatch reservation follows in its own short transaction; it is not nested in the job insert. A short read of in-flight jobs supplies the remaining monthly request quota to admission. After admission succeeds, one short Organization transaction takes the existing per-Organization advisory lock as the single serialization point, re-counts in-flight jobs, applies the application-owned room policy, and inserts the job row. A submit that loses that re-check is compensated and receives the existing `QUOTA_EXCEEDED` refusal; the graded admission call is not repeated. The in-flight refusal is a separate serialization outcome, not a second rate-limit, retry-budget, or quota decision from Redis.

The rejected alternative was to keep the original order and bound the hold with a deadline. That still occupies a pooled connection and the Organization's lock for the whole Redis round trip, and a missing quota counter can pull a second connection into the window. The accepted order admits a false-positive when two callers read the same remaining quota: under the lock one wins and the other is compensated. ADR-0192 already makes the aggregate limit and idempotent accounting, not a deterministic winner, the contract. Rate-limit and Organization retry-budget entries consumed by the late loser are not refunded.

The monthly quota counter remains a read-only heuristic at admission and is incremented at metering, as ADR-0018 and ADR-0019 require. Bounds come from the gateway Redis command timeout and each PostgreSQL transaction timeout; no spanning deadline, distributed lock, saga, or Redis-side in-flight counter is introduced. The Sandbox dispatch reservation and the job insert remain two sequential transactions by design: the first commits and releases its lock before the second opens, so there is no nesting or lock-ordering hazard.

ADR-0057's declared graded-chain order and ADR-0159's PostgreSQL job row as source of truth are unchanged. The late in-flight refusal is recorded as a separate outcome after the chain, so the single Graded admission decision per request still holds.
