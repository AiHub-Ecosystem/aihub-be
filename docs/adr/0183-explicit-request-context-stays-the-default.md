# ADR-0183: Keep explicit request context as the default

- Status: Accepted
- Date: 2026-11-25
- Related: [#1320](https://github.com/AiHub-Ecosystem/aihub-be/issues/1320), [#417](https://github.com/AiHub-Ecosystem/aihub-be/issues/417), [ADR-0063](0063-request-tracing-through-otlp.md)

## Context

Issue #1320 proposed replacing explicit request-context passing with an
`AsyncLocalStorage` (ALS) store, confining ALS to distributed tracing, and
banning `als.enterWith()`. The claimed 5%–15% promise-heavy throughput penalty
had no local evidence: the repository has no first-party `AsyncLocalStorage`
call, no `enterWith()` call, and no ALS-based service contract. Application
code already passes `RequestContext` explicitly through controllers and use
cases, with Organization identity made explicit at the boundary. The only
implicit context in the process comes from libraries: OpenTelemetry's context
manager, entered by `context.with()` in the outer `onRequest` hook, and
nestjs-pino's `runInContext()` for `request_id` log bindings.

## Evaluation

The isolated capacity benchmark ran twice on a GitHub-hosted `ubuntu-24.04`
runner through the manually dispatched `Issue 1320 ALS benchmark` workflow.
Both runs used the same Docker stack, 2,000 k6 VUs, 16 and 2,000 requests/s
stages, a 2-second stub delay, and one repetition. The ALS variant replaced
the explicit `RequestContext` argument with an ALS `getStore()` lookup on the
dispatch path; everything else matched the baseline.

- Both runs finished every stage, but the runner's Argon2 contention and
  adaptive-concurrency acceptance checks failed, so the reports are
  `partial-results.json`, not accepted capacity baselines.
- At 2,000 requests/s nearly all responses were errors, so throughput and
  event-loop lag there do not isolate context-passing cost.
- At 16 requests/s, mixed grading p99 was 2412.75 ms baseline against 2407.71 ms
  ALS, while event-loop lag peak was 77.7 ms baseline against 85.3 ms ALS.
  Writing Task 1 alone had 25.3 ms against 35.6 ms lag peak.
- The 2,000 requests/s stage reversed the lag direction: 177.9 ms baseline
  against 153.4 ms ALS.

One repetition under an overloaded workload cannot establish a 5%–15% penalty.
The measurement is inconclusive, not evidence of benefit.

## Decision

- Keep explicit `RequestContext` passing as the default for business logic. It
  is already the architecture and no contract refactor is required.
- Keep implicit context limited to the **observability context boundary**:
  OpenTelemetry trace context and request-log bindings. Record that term in
  `GLOSSARY.md` so it includes log bindings, not only tracing.
- Add no `als.enterWith()` or `als.run()` architecture rule now. There is no
  first-party ALS to forbid, and a ban should follow a concrete proposal with
  evidence, not an unverified performance claim.
- Do not treat the 5%–15% figure as a fact. Re-open the evaluation with paired
  repetitions at a non-saturating rate if ALS is proposed again.
- The manual workflow and harness changes used for this evaluation stay as
  evaluation tooling. They do not change production request handling.

## Consequences

ADR-0063 and the request-tracing hook are unchanged. The in-process context
retention verified in #417 remains owned by that issue. A future first-party
ALS proposal must first pass the same controlled comparison and then file its
own implementation issue; this ADR does not authorize one.
