# ADR-0152: Evaluate Canva-style In-Process Bloom Filter Revocation Cache

- Status: Proposed — evaluation only; not adopted for authorization
- Date: 2026-11-06
- Amends: none — this proposal does not amend [ADR-0150](0150-revoke-individual-user-access-jwts.md).
- Related: [#1252](https://github.com/AiHub-Ecosystem/aihub-be/issues/1252), [#518](https://github.com/AiHub-Ecosystem/aihub-be/issues/518), [#1745](https://github.com/AiHub-Ecosystem/aihub-be/issues/1745), [#1861](https://github.com/AiHub-Ecosystem/aihub-be/issues/1861), [ADR-0150](0150-revoke-individual-user-access-jwts.md)

## Context

Under ADR-0150, Bearer token verification executes a durable PostgreSQL query (`SELECT EXISTS(...) FROM user_access_token_revocations`) on every authenticated request. Under peak loads of 10,000+ req/s:

- Checking token revocation generates tens of thousands of database/Redis network round-trips every second.
- Any transient database latency jitter or network blip directly degrades API authentication response times.

Issue #1252 evaluates Canva's In-Process Revocation Filter pattern to verify JWT validity locally with zero network round-trips on valid tokens.

## Decision & Evaluation Findings

The prototype findings below do not describe the active protected-request path.
Until a synchronization design proves complete revocation delivery, every
protected Bearer request uses the direct Postgres lookup required by ADR-0150.

- Prototype `InProcessBloomFilter`:
  - In-memory compact bitset using `Uint8Array` (< 1MB RAM for 100,000 tokens at $p < 0.001\%$).
  - Configurable false positive rate ($p < 0.001\%$).
  - Fast 32-bit FNV-1a double-hashing (Kirsch-Mitzenmacher optimization).
- Prototype `BloomFilterUserAccessTokenRevocationAdapter`:
  - Implements `UserAccessTokenRevocationRecordPort`.
  - Fast path: If `bloomFilter.has(key)` is `false`, token is definitely not revoked (zero false negatives). Returns `false` immediately with 0 network calls.
  - Slow path: If `bloomFilter.has(key)` is `true` (true positive or false positive $< 0.001\%$), falls back to durable store (Postgres). If the durable store returns not revoked, the token is accepted. This guarantees zero false rejections.
  - Synchronization: When `revoke()` is called, writes to durable storage, updates local filter, and broadcasts to peer instances via Redis Pub/Sub (`aihub:auth:token-revocations`).
- Benchmark verification (`bloom-filter-revocation-benchmark.spec.ts`):
  - The prior benchmark's zero-query and throughput claims applied only to the
    local prototype and did not cover missed Pub/Sub delivery. They are not
    production guarantees and no longer describe the active lookup path.
  - The #1745 zero-query target applied only to the revocation lookup; the
    Bearer guard still performs its separate account-status lookup.

## Production Adoption Requirements

Before considering production activation:

1. **Generational/Rolling Windows**: Use two rolling Bloom Filters rotated at token TTL (15 minutes) so expired tokens naturally age out without unbounded bitset saturation.
2. **Cold-start Hydration**: At worker startup, pre-warm active unexpired revocations from Postgres into the current generational filter.

Rolling-window rotation remains unimplemented. A filter miss must not be used
for authorization unless a future synchronization design proves that it cannot
omit a committed revocation.

## Consequences

- The proposed filter reduces memory use only; it does not currently reduce
  revocation-query traffic on protected requests.
- Every protected Bearer request depends on Postgres for revocation state and
  fails closed with a retryable 503 during a database outage.
- The prototype's memory estimate is under 1MB per instance for 100,000
  revocations at the measured false-positive rate.
