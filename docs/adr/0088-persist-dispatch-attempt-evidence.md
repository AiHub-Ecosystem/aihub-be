# ADR-0088: Persist evidence for each AI Service dispatch attempt

- Status: Accepted
- Date: 2026-10-10
- Related: [#477](https://github.com/AiHub-Ecosystem/aihub-be/issues/477), [#472](https://github.com/AiHub-Ecosystem/aihub-be/issues/472), [ADR-0016](0016-metering-boundary-and-billing-evidence.md), [ADR-0019](0019-quota-reconciliation-from-durable-usage.md), [ADR-0023](0023-thirteen-month-usage-retention.md), [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md)

## Context

`usage_records` is written when an authenticated request completes. If the
AIHUB process dies after a downstream request may have been sent but before
completion, that row and its quota evidence may never be written. A durable
record created before dispatch can preserve evidence of the attempt, but a
process can also die after creating the record and before sending the request.
The record therefore cannot prove that an AI Service processed the request or
incurred cost.

## Decision

Dispatch evidence lives in a separate Nest module because `MeteringModule`
already imports `GatewayModule`; keeping the gateway-facing recorder out of
`MeteringModule` avoids a dependency cycle and lets the dispatch pool own its
lifecycle.

Persist one mutable Postgres dispatch-attempt row for each outbound call before
calling the AI Service. Store the request ID, Organization, operation, creation
time, and the attempt's fixed `unknown_after` deadline. Do not store essay,
audio, or other submission content. Keep this evidence separate from the
append-only `usage_records`, which remain the source of billable usage and
quota reconciliation.

If the row cannot be created, fail closed with the existing `INTERNAL_ERROR`
500 response and do not call the AI Service. Record a received HTTP response,
including 4xx or 5xx, as known; record a failure definitely before send as
`not_dispatched`; and preserve transport ambiguity as `outcome_unknown`. If
the process dies before recording a definitive outcome, the attempt becomes
unresolved for reporting after its stored deadline, which is twice the
operation timeout in force when the attempt was created.

Expose a bounded `/metrics` gauge grouped by operation. At scrape time, query
Postgres for attempts past `unknown_after` whose outcome is absent or unknown,
excluding attempts with matching final usage evidence. An `AI_SERVICE_TIMEOUT`
usage row is not final evidence by itself: required-idempotency Writing may
return that timeout while the grading call continues in the background. Keep
those attempts visible until dispatch outcome evidence is recorded or the
retention window expires. Aggregate retired operation IDs under the bounded
`other` label so historical rows cannot invalidate the whole scrape. Do not
add a scheduled state-transition worker or manual override. A failure to
persist a known downstream outcome must not change a successful response
already returned to the customer.

Report unresolved attempts as unresolved/unpriced in the cost-report work
tracked by #457; do not assign an amount without authoritative provider usage
and pricing. Preserve current API, idempotency, and customer retry behavior;
result retrieval or replay belongs to #478. Retain attempt evidence for the
same rolling 13-calendar-month window as usage records through the existing
usage-prune maintenance path.

## Considered options

- **Use `usage_records` as the pre-dispatch record:** rejected because it
  changes the completion and billing evidence boundary. A dispatch attempt is
  not itself proof of a billable request, and `usage_records` remains
  append-only.
- **Rely on logs or in-memory request evidence:** rejected because both can be
  lost when the process terminates.
- **Run a worker that marks expired rows unknown:** rejected because the
  metrics scrape can derive unresolved counts from durable rows and their
  stored deadlines without another scheduler or mutable state transition.
- **Automatically retrieve or replay an uncertain result:** deferred to #478;
  replay could invoke the model a second time when the first result is not
  known.

## Consequences

The durable write is on the dispatch path. Its latency must fit the budget
defined by #472, and its failure prevents the downstream call. A process crash
or ambiguous transport result remains uncertainty rather than confirmed spend;
the metric and cost report must preserve that distinction. Existing successful
customer responses remain successful if a later evidence update fails.
