# ADR-0089: Measure request duration from ingress

- Status: Accepted
- Related issue: #471
- Amends: [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md) (request timing only)

## Context

`total_ms` was measured from the success interceptor on successful requests and
from Fastify's response window on failures. Both began after some or all of the
body parsing and graded-request guards, so neither matched spec 02 §D.3's
request-receipt start. The split also made success and error durations
incomparable.

## Decision

Capture one monotonic start time in the first Fastify `onRequest` hook. Use it
for successful envelopes and metering records, exception-filter records, and
completion logs for requests without a metering record. Record the elapsed time
until dispatch starts, or until a pre-dispatch refusal is handled, as
`admission_ms` in the completion log and in
`aihub_admission_duration_seconds{operation}`. The metric uses the catalog's
bounded operation label. Do not persist `admission_ms` or add it to the public
response envelope. An idempotency replay that returns without dispatch omits
`admission_ms` because no dispatch admission occurred.

For a request with Metering evidence, sample `total_ms` when the operation
result or refusal is ready, before awaiting metering finalization. Reuse that
sample in the successful response timing, durable usage record, completion log,
and request histogram. It excludes usage-record persistence and response
delivery, so it is not client-observed end-to-end latency. Requests without
Metering evidence continue to sample their duration in the completion hook.

## Consequences

Success and failure `total_ms` values now share the same ingress boundary and
include body parsing and admission work. The response timing and durable usage
record continue to share one value. Admission time can be compared separately
from total and downstream duration without adding an unbounded metric label.
