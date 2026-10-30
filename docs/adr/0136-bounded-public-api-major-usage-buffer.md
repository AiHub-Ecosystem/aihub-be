# ADR-0136: Bound Public API major usage collection

- Status: Accepted under [#1406](https://github.com/AiHub-Ecosystem/aihub-be/issues/1406).
- Date: 2026-10-30
- Amends: [ADR-0127](0127-public-api-uri-major-versioning.md), specifically its claim that a process loses usage counts only when it dies before writing them
- Related: [ADR-0125](0125-bounded-protection-metrics.md), [#1406](https://github.com/AiHub-Ecosystem/aihub-be/issues/1406)

## Context

Public API major usage is adoption evidence, not billing evidence. Its in-process maps coalesce samples by UTC day, major, and Organization, with unattributed traffic held separately. An unbounded database outage could otherwise grow either map without limit.

## Decision

- Each active buffer holds at most 16,384 distinct key slots total across its attributed and unattributed maps. The flusher can hold one pending write batch while the live buffer collects newer samples, so one process can retain up to 2 × 16,384 keys.
- When a new key would exceed the active-buffer cap, that sample is dropped and the label-free `aihub_public_api_major_usage_samples_dropped_total` counter increments. Existing keys continue aggregating. The response hook remains synchronous and does no database I/O.
- The next successful write persists the dropped interval with that write's counts and collection record. The batch number makes a retry write the interval only once. Every UTC day touched by a persisted interval is inconclusive in adoption coverage.
- The record beside `PUBLIC_API_MAJOR_USAGE_MAX_KEYS` contains the measured uncapped per-key growth and the retained heap and RSS figures from a 768 MiB container run under the measured outage workload. The 16,384-key bound is per buffer; one process can retain up to 2 × 16,384 keys.
- A crash after samples were dropped but before a successful write persists their interval loses that interval. The existing 5-minute no-process gap rule then applies; a burst above the cap within one 30-second flush followed by a crash within 5 minutes can still yield a `complete` verdict. This known limit is accepted for adoption evidence and does not change the retirement sign-off rule.

## Consequences

The collector remains best-effort usage telemetry. Saturation is observable, retained samples continue to flush after database recovery, and reports identify recorded loss; no durable guarantee is made for a dropped interval still held only in process memory.

## Confirmation

This amendment updates the adoption-evidence loss policy for #1406. It does not change the Public API contract or make usage counts billing evidence.
