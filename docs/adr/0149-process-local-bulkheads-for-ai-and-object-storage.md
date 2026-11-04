# ADR-0149: Adopt process-local bulkheads for AI and object storage clients

- Status: Accepted — recorded by AIHUB owner @lengocanh2005it in [#1250](https://github.com/AiHub-Ecosystem/aihub-be/issues/1250) on 2026-11-04.
- Date: 2026-11-04
- Related: [#1250](https://github.com/AiHub-Ecosystem/aihub-be/issues/1250), [#1590](https://github.com/AiHub-Ecosystem/aihub-be/issues/1590), [ADR-0098](0098-ai-service-work-deadline.md)

## Context

Issue #1250 asks whether resource bulkheading can stop a slow downstream
service from consuming the process capacity needed by unrelated requests. The
source audit found two relevant HTTP client boundaries:

- `DownstreamHttpClient` has an Undici Pool per configured AI-service origin
  with `connections: 10`, but that connection setting does not cap concurrent
  HTTP/2 streams or requests waiting inside the process.
- The shared SeaweedFS S3 client has an HTTP(S) Agent with `maxSockets: 16`.
  Node queues requests beyond that socket count, and the client had no admission
  limit on the pending work.

AIHUB calls configured AI-service origins; it does not directly call OpenAI,
Anthropic, or Whisper vendor endpoints. JWKS refreshes already limit concurrent
organizations, Resend delivery is sequential, and Redis/Postgres connection
budgets have separate owners.

## Decision

Adopt small, process-local, fail-fast semaphores at the existing AI-service and
object-storage client boundaries. Do not add Shopify's Semian library or a
generic cross-client abstraction.

- Admit at most 10 requests concurrently per configured AI-service origin.
  The limit matches the existing Undici Pool connection setting. Reject excess
  work with retryable `AI_SERVICE_UNAVAILABLE`; release capacity after response
  consumption, parsing, error handling, or cancellation settles.
- Admit at most 16 concurrent commands through the shared S3 client, matching
  the HTTP(S) Agent's `maxSockets`. Fail excess commands immediately and report
  the bounded `bulkhead_exhausted` failure reason.
- Keep the limits local to each process and static. They contain a stalled
  dependency by refusing excess work rather than queueing it. Adaptive tuning
  remains the scope of #1590, which is already filed in the Gateway capacity
  milestone and is blocked by #1250.

## Consequences

Requests over a limit receive a fast failure instead of waiting for a client
queue. A retry may succeed after an in-flight request settles. These are
per-process limits, so total concurrency grows with the number of running
instances; this decision does not provide a cross-instance cap. The S3 queue
depth metric remains useful for observing SDK-internal work but is not used as
an admission signal.

The route isolation test stalls all 10 AI Speaking slots for 30 seconds, then
checks that a successful in-memory Core Auth login and successful Writing grade
both respond in under 20 ms. The S3 integration test checks fail-fast behavior
at the socket budget and the corresponding metric. These mocked tests verify
the process boundary; they are not live-provider or production measurements.
