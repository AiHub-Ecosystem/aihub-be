# ADR-0012: Defer distributed tracing in Stage A

- Status: Superseded by [ADR-0063](0063-request-tracing-through-otlp.md)
- Date: decided 2026-09-07 in the implementation specification suite; superseded when ADR-0063 was accepted
- Supersedes: nothing
- Superseded by: [ADR-0063](0063-request-tracing-through-otlp.md) — spans are opt-in through an external OTLP endpoint; no collector is bundled

## Context

Stage A has few organizations and a small team. A bundled tracing collector is
another moving part that can fail at 3 AM, and Stage A's debugging needs were
judged coverable by structured logs.

## Decision

Omit distributed tracing in Stage A. Structured request logs and metrics cover
the observable needs of the scale.

## Consequences

- Superseded: [ADR-0063](0063-request-tracing-through-otlp.md) adopted scoped
  OpenTelemetry instrumentation (Fastify requests, ioredis, Postgres, Undici)
  exporting to an **optional external OTLP endpoint**, preserving the original
  rationale — no collector is bundled, and tracing stays opt-in — while
  restoring request-stage visibility.
- This record is kept because ADR-0001–0012 were written retroactively from
  the specification suite (see the index); the original numbering is preserved
  rather than renumbered.
