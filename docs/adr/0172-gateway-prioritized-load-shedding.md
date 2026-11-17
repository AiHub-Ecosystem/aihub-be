# ADR-0172: The gateway sheds load by request tier and keeps the tier local

- Status: Accepted
- Date: 2026-11-17
- Related issue: [#1591](https://github.com/AiHub-Ecosystem/aihub-be/issues/1591)
- Related: [ADR-0154](0154-adaptive-concurrency-limit-for-ai-service-dispatch.md), [ADR-0168](0168-gateway-multi-instance-admission.md), [#398](https://github.com/AiHub-Ecosystem/aihub-be/issues/398), [#581](https://github.com/AiHub-Ecosystem/aihub-be/issues/581)

## Context

The adaptive concurrency limiter (ADR-0154) stops one origin from being pushed
past its estimated capacity, and the retry budget stops a retry storm. Neither
decides **which** request to refuse. Under saturation the limiter refuses
whoever arrives when the permit count is empty, so a burst of Writing grading
can lock sign-in out of the same host. Netflix's prioritized load shedding keeps
the cheap, load-bearing calls alive by refusing the expensive ones first; Google
SRE covers the same trade under "criticality".

The trigger already exists: `Gradient2ConcurrencyLimiter.snapshot()` reports
`inFlight / limit` per origin. What was missing is a tier for each request, a
refusal that costs almost nothing, a shared decision so peers do not disagree,
and metrics an alert can read.

## Decision

1. A request's tier comes from its **method and path alone**, resolved in a raw
   Fastify `onRequest` hook before the body is read or parsed. An unknown path
   stays `critical` so its `404` still reaches the caller; a refused `404`
   protects nothing and turns a typo into an outage signal.
2. Three tiers. `best-effort` is every operation that dispatches to an AI
   Service during the request. `critical` is the control plane a caller needs in
   order to keep operating: authentication and sessions, MFA, password recovery,
   email verification, Organization and API-key management, Sandbox assertion
   minting, and `GET /v1/me`. Everything else is `standard`.
3. The trigger is the peak `inFlight / limit` over origins. `best-effort` is
   shed at `0.9`, `standard` as well at `1.0`. `critical` is never shed: the
   dispatch is what saturates the host, and a refused authentication cannot even
   tell the caller to slow down.
4. Recovery is hysteretic. A tier is restored only after utilization stays below
   `0.75` for 20 s, and a restore restarts that window, so a dip between two
   spikes cannot flap the level. Changes are spaced at least 1 s apart, so a jump
   escalates one tier at a time.
5. The level is shared through Redis (ADR-0168), because an instance that has
   not seen the spike must not keep admitting what a peer is already shedding.
   Reads are served from process memory and refreshed on a timer; a refusal never
   waits on Redis. A lower publish never lowers the shared key — it is raised and
   expires on its own TTL, and a failed Redis read keeps the last known level.
   Redis being down never sheds by itself.
6. The refusal is `503 SERVICE_OVERLOADED` with `Retry-After` and
   `error.retry_after_ms`. `aihub_shed_requests_total` and
   `aihub_tier_requests_total` are labeled by tier; `aihub:shed_ratio:rate5m` is
   their ratio and `AIHUBSheddingSustained` alerts above 20% for 10 minutes.

## Tier propagation to the AI Services

The tier is **not** propagated. The gateway decides from the route, and the AI
Service contract stays unchanged. Propagating criticality across the whole RPC
chain is what Google does, but it requires every AI Service to accept a
priority field, honour it in its own admission, and keep it compatible across
releases; none of that is true today, and inventing a header the services
ignore would suggest a guarantee they do not make. If per-RPC criticality is
wanted later, it is its own issue against the AI Service contract.

## Consequences

- A saturated host refuses cheap, retryable grading instead of expensive
  control-plane traffic, and the refusal is a header plus a small JSON body.
- Clients that already retry on `503` with `Retry-After` need no change; the
  integration guide names the tier table and the new code.
- The tier table lives beside the route registry, so a new route without a tier
  answer is a visible omission rather than a silent default.
- The Redis round trip is on the governor's timer, never on the request path, so
  a slow Redis costs a stale level rather than latency.
