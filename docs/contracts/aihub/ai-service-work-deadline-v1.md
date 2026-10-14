# AIHUB to AI Service work-deadline contract v1

Status: Proposed; pending written approval by the AI Writing service owner, AI
Speaking service owner, WISPACE, and AIHUB.

This contract defines the internal `x-request-deadline` header. AIHUB already
sends the header; its presence is not evidence that a service or model provider
stops work when the deadline expires.

## Header

`x-request-deadline` is the positive base-10 integer number of milliseconds
remaining in AIHUB's effective dispatch work budget, measured immediately
before each outbound call. AIHUB recomputes it for every call; it is a duration,
not an epoch timestamp. AIHUB does not dispatch work after the effective work
deadline has expired.

The service starts its local deadline when it receives the request. It accepts
the header only when it contains a positive base-10 integer, then clamps that
duration to the service's configured local timeout. A missing, malformed, zero,
or otherwise non-positive value uses the existing local timeout and does not
cause the request to be rejected. The header can shorten the local timeout but
never lengthen it.

## Deadline selection

- For ordinary Writing and Speaking calls, AIHUB's dispatch work deadline is the
  request deadline, measured from when AIHUB received the request.
- Required-idempotency Writing uses the hard deadline supplied to the idempotent
  work. That work may continue after the caller response deadline or client
  disconnect, until the hard deadline aborts it. The current hard timeout is
  twice the operation timeout (about 120 seconds for current 60-second Writing
  grading routes); the response deadline remains separate.
- At each dispatch, AIHUB sends the time remaining until the applicable work
  deadline. A downstream service must not substitute the caller response
  deadline for the Writing background work deadline.

## Cancellation and evidence

When the effective work deadline expires, AIHUB aborts its in-flight HTTP call.
That proves only that AIHUB stopped waiting/sending on its side; it does not by
itself prove that the AI Service or model provider stopped computation. Such a
claim requires service-owned implementation and tests.

AIHUB tests prove header values and deadline-triggered aborts against a stub.
Service owners separately implement and test honoring the header. The required
approvals are recorded in writing before this contract is marked accepted.

Timeout metering remains `downstream_error` with `AI_SERVICE_TIMEOUT`; dispatch
attempt evidence follows [ADR-0092](../../adr/0092-persist-dispatch-attempt-evidence.md).
Billing for late idempotent Writing completion remains as defined by
[ADR-0097](../../adr/0097-billing-statements-adjustments-and-closed-months.md).
