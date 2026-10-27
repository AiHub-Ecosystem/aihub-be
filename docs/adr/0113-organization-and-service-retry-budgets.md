# ADR-0113: Bound organization and service retry amplification

- Status: Partly implemented: the Organization edge retry budget and bounded 10,000-key ledger shipped ([#850](https://github.com/AiHub-Ecosystem/aihub-be/issues/850)); the per-service retry bucket remains proposed pending capacity evidence in [#632](https://github.com/AiHub-Ecosystem/aihub-be/issues/632)
- Date: 2026-10-19
- Related: [#632](https://github.com/AiHub-Ecosystem/aihub-be/issues/632), [#332](https://github.com/AiHub-Ecosystem/aihub-be/issues/332), [#199](https://github.com/AiHub-Ecosystem/aihub-be/issues/199), [#403](https://github.com/AiHub-Ecosystem/aihub-be/issues/403), [#457](https://github.com/AiHub-Ecosystem/aihub-be/issues/457), [#273](https://github.com/AiHub-Ecosystem/aihub-be/issues/273), [#327](https://github.com/AiHub-Ecosystem/aihub-be/issues/327), [#304](https://github.com/AiHub-Ecosystem/aihub-be/issues/304), [#659](https://github.com/AiHub-Ecosystem/aihub-be/issues/659), [#494](https://github.com/AiHub-Ecosystem/aihub-be/issues/494)

## Context

Retries can multiply work across the client, AIHUB, and the AI Service's model-provider call. A circuit breaker addresses a downstream service that is failing; it does not bound the retries admitted before the breaker opens ([ADR-0076](0076-terminus-readiness-and-opossum-breakers.md)).

AIHUB currently makes one downstream dispatch attempt. The bounded retry behavior in #332 is proposed, not active. AIHUB cannot observe retries made by AI Writing or AI Speaking to their model providers, so those factors must remain unknown until their service owners confirm them.

The only reliable retry signal currently available at the AIHUB edge is a subsequent request with the same Organization, operation, and `Idempotency-Key`. A request ID changes on a client retry, and `X-Correlation-Id` is optional and client-controlled ([#494](https://github.com/AiHub-Ecosystem/aihub-be/issues/494)). Writing requires idempotency. Speaking declares `none`, so its repeated requests cannot be classified this way until #304 decides its idempotency contract.

Capacity evidence is incomplete: #273 still needs provider concurrency, and #327 has no staged baseline. #327 measures AIHUB against a stub; #273 must supply the AI Service side. If provider evidence gives concurrency only, a latency or throughput mapping is also needed before turning it into requests per second. Therefore an absolute service retry rate cannot yet be grounded in measured capacity.

## Decision

### Client retries at the AIHUB edge

Call a repeat retry-eligible only when it reuses the original `Idempotency-Key` for the same Organization and operation, and that operation supports idempotency. Count every such repeat against the Organization budget, including in-flight duplicates and completed replays. A new key is a new first attempt for this policy and is not classified as a retry.

For each Organization, allow no more than 10% retry-eligible repeats relative to first attempts in a rolling 60-second window, with a minimum allowance of one repeat per window. Expressed as integer counts, the allowance is `max(1, floor(0.10 × first_attempts))`. The counter is Organization-wide across AIHUB instances, not process-local.

When the allowance is spent, refuse the repeat with `429` and `Retry-After`. This protection applies even when a completed result is available: the caller can retry after the indicated wait to retrieve it. The refusal does not dispatch another model request or create another billable grading. Once admitted, a completed Writing replay still returns its stored result even if monthly quota is exhausted, as #659 specifies. Keep the response header aligned with the body hint and #403.

The one-repeat floor deliberately permits a 2x request factor for an Organization with one first attempt in the window. At higher volume, the 10% ratio bounds edge request amplification to 1.1x. A client that retries with a fresh key is outside this retry classifier and remains subject to the existing request admission controls.

### Remembered-key ledger

Classification needs memory: the gateway remembers each (Organization, operation, Idempotency-Key) for 24 hours so a later request with
the same key is a repeat. That ledger is one Redis sorted set per Organization and is capped at 10,000 remembered keys per Organization
(#850). At the ceiling the oldest keys are dropped, so a dropped key's next request counts as a first attempt: the budget becomes more
permissive for an old key, and it never refuses a first attempt it could not classify. The cap is a memory safety bound, not a capacity
promise. Redis is not an evictable cache here, and the quota counter, rate limit, and concurrency leases share the instance; an unbounded
ledger would fail their writes too, not only this budget's. A measurement on Redis 7.4.10 of a sorted set holding 10,000 64-character
hex members with millisecond scores reports 1,695,520 bytes through `MEMORY USAGE <key> SAMPLES 0`; a second set of the same size
reported 1,697,120 bytes, and the marginal cost between 10,000 and 20,000 members was 169.4 bytes per member. One Organization's
ledger therefore stays near 1.7 MB at the ceiling, which bounds a deployment holding N Organizations at about 1.7 MB × N — roughly
17 MB at ten Organizations and 170 MB at one hundred. Re-measure and record the result before raising the cap.

### AIHUB retries to an AI Service

Keep #332's per-operation retry budget and add one token bucket shared by all operations targeting each downstream service. The operation budget is 10% of first attempts over a rolling 60 seconds. It limits retries for one operation; the service bucket also limits aggregate retries when several operations share that service.

Let `C_s` be the lower of (a) AIHUB's sustainable first-attempt throughput for the deployment sharing this bucket, established from #327's per-process benchmark with a verified topology/replica mapping or a direct deployment-level measurement, and (b) the service owner's confirmed sustainable throughput from #273. Do not assume that a single-process result scales linearly. Set the service bucket refill rate to `0.10 × C_s` retry tokens per second. If #273 provides concurrency only, obtain a confirmed latency/throughput mapping before deriving requests per second. Record and test the bucket's burst capacity alongside the measured rate.

When an AIHUB retry budget is exhausted, fail fast: skip the next retry and return the last real downstream error in the operation's existing error envelope, as #332 specifies. This applies to Writing and Speaking dispatches. Do not queue or serve a cached result. If a retry is admitted, it remains subject to the per-operation circuit breaker before every dispatch attempt; the breaker and retry budget solve different problems.

### Amplification estimate and limits

For a 5x same-key client retry storm (four repeats per first attempt), the edge admits at most `max(1, floor(0.10 × first_attempts))` repeats per Organization in 60 seconds and refuses the rest with `429`. At ten or more first attempts, accepted edge traffic is at most 1.1x; at one first attempt, the minimum allowance permits at most 2x for that Organization in the window.

Same-key Writing replays do not create another model dispatch, so this edge factor describes AIHUB ingress, not a multiplier on Writing model calls. Today AIHUB's downstream dispatch factor is 1.0 because it makes one attempt. If #332's retries are enabled, use the per-operation 10% budget and service token bucket to bound AIHUB-originated attempts. The end-to-end formula remains `edge factor × gateway factor × provider factor` only for layers whose retries actually issue another downstream call; same-key idempotent replays short-circuit before that multiplication. The provider factor is unknown pending confirmation by the AI Service owners.

This estimate does not cover Speaking retries until #304 resolves idempotency, or client retries that use a fresh key. Do not present it as a whole-platform bound while either gap remains.

### Evidence and implementation boundary

Use #457's per-Organization spend monitoring to detect when retry costs exceed expectations. It is an alarm, not a retry control. Keep replay identification distinct from ordinary non-billable successes as #494 specifies.

The Organization edge budget shipped at the gateway idempotency boundary, and #850 bounded its remembered-key ledger. The per-service bucket rate remains gated on the #273 provider-capacity evidence and #327 AIHUB baseline; #327 currently measures one process against a stub and has no staged baseline, so its result needs a verified mapping to the bucket's deployment scope or a direct deployment-level measurement. Do not assume linear scaling or enable the service bucket with an invented rate. Coordinate its retry response with #403 and completed-replay behavior with #659. If #332's proposed retry loop is implemented, it must enforce the per-operation budget and shared service bucket. The current Speaking exclusion is accepted scope for this decision, with its future idempotency contract left to #304.

## Consequences

The edge policy gives retry-capable operations a measurable Organization-level ceiling while preserving a minimal recovery path for low-volume Organizations. The minimum allowance means the high-volume 1.1x factor is not a universal per-window bound. Speaking and fresh-key retries are not covered by this classifier, and provider-owned retries remain an external unknown.

The numeric per-service retry rate cannot be stated yet without inventing capacity. The accepted implementation target is 10% of the lower confirmed sustainable throughput at the bucket's deployment scope; closing #632 before those measurements would leave its tokens-per-second criterion unverified.
