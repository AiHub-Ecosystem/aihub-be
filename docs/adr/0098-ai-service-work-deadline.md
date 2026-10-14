# ADR-0098: Bound AI Service work by an AIHUB dispatch deadline

- Status: Proposed; written approval from the AI Writing owner, AI Speaking owner, WISPACE, and AIHUB is pending
- Date: 2026-10-14
- Related issue: [#633](https://github.com/AiHub-Ecosystem/aihub-be/issues/633)
- Related: [ADR-0089](0089-ingress-based-request-timing.md), [ADR-0092](0092-persist-dispatch-attempt-evidence.md), [ADR-0097](0097-billing-statements-adjustments-and-closed-months.md), [AI Service work-deadline contract](../contracts/aihub/ai-service-work-deadline-v1.md)

## Context

AIHUB already sends `x-request-deadline` on outbound Writing and Speaking calls.
Today it computes the value before persisting the durable dispatch-attempt row;
time spent persisting can make the header and local timeout stale by the actual
send. Issue #633 must recompute the budget immediately before the outbound call.
The header does not prove that an AI Service or its model provider honors
cancellation, so AIHUB tests must not claim that provider compute stops.

The ordinary response budget starts when AIHUB receives the request (ADR-0089).
Required-idempotency Writing can return a timeout while its grading continues in
the background. That work has its own hard deadline and must not inherit the
caller disconnect signal. The response and work deadlines therefore describe
different lifetimes.

## Decision

- Keep the AIHUB response deadline anchored to request receipt. At each outbound
  call, compute the positive integer milliseconds remaining until its effective
  dispatch work deadline and send them in `x-request-deadline`.
- For ordinary dispatches, the effective work deadline is the request deadline.
  For required-idempotency Writing, use the idempotency work's hard deadline
  (currently twice the operation timeout, about 120 seconds for the 60-second
  grading routes). The work may continue after the caller's response deadline
  or disconnect, but not beyond that hard deadline.
- The header is a relative upper bound, not an absolute timestamp. An AI Service
  accepts only a positive base-10 integer, clamps it to its own local timeout,
  and uses its local timeout when the header is absent or invalid. It does not
  reject a request because of this header. Thus the header can shorten, never
  extend, the service's local timeout. These semantics remain proposed until
  written approval is recorded from the AI Writing owner, AI Speaking owner,
  WISPACE, and AIHUB.
- AIHUB tests use a stub service to prove header emission and that AIHUB aborts
  an in-flight call at the effective work deadline. They do not prove the
  provider stopped model computation. Service-owned honoring behavior and tests
  are separate follow-up work if either service does not implement the contract.
- Record `aihub_dispatch_deadline_ms_remaining` as a histogram with only the
  bounded operation label immediately before each outbound call. Increment
  `aihub_dispatch_cancelled_by_deadline_total` only when an AIHUB work deadline
  aborts an in-flight downstream call. Exclude caller disconnects, connection
  failures, downstream error responses, and calls that expire before dispatch.
- Keep timeout metering as `outcome = 'downstream_error'` and
  `error_code = 'AI_SERVICE_TIMEOUT'`; do not add `deadline_exceeded` to the
  persisted enum or reports. Dispatch evidence continues to follow ADR-0092:
  a received status is `response_received`, a definite pre-send failure is
  `not_dispatched`, and an ambiguous post-send failure is `outcome_unknown`.
- Do not change ADR-0097 billing. A Writing 504 remains non-billable; a late
  successful background result is billed once when stored, whether or not it is
  later fetched.

## Consequences

The header communicates an AIHUB time budget. A service's honoring of that
budget remains unverified until the service implements and tests the accepted
contract. AIHUB metrics and stub tests must distinguish its own deadline abort
from a client disconnect or transport failure. The original timeout response
and late Writing billing behavior remain unchanged.
