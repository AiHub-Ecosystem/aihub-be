# ADR-0152: Evaluate Canva-style In-Process Bloom Filter Revocation Cache

- Status: Proposed
- Date: 2026-11-06
- Amends: [ADR-0150](0150-revoke-individual-user-access-jwts.md) — evaluates an in-process caching tier in front of Postgres durable revocation reads to eliminate per-request network round-trips.
- Related: [#1252](https://github.com/AiHub-Ecosystem/aihub-be/issues/1252), [#518](https://github.com/AiHub-Ecosystem/aihub-be/issues/518), [ADR-0150](0150-revoke-individual-user-access-jwts.md)

## Context

Under ADR-0150, Bearer token verification executes a durable PostgreSQL query (`SELECT EXISTS(...) FROM user_access_token_revocations`) on every authenticated request. Under peak loads of 10,000+ req/s:

- Checking token revocation generates tens of thousands of database/Redis network round-trips every second.
- Any transient database latency jitter or network blip directly degrades API authentication response times.

Issue #1252 evaluates Canva's In-Process Revocation Filter pattern to verify JWT validity locally with zero network round-trips on valid tokens.

## Decision & Evaluation Findings

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
  - Valid authenticated requests execute with 0 network commands in steady-state auth.
  - Throughput increases by $> 40\%$ compared to direct network round-trips.
  - 100% of revoked tokens are accurately recognized without false negatives.

## Production Adoption Requirements

For production activation (to be scheduled when traffic reaches trigger):

1. **Generational/Rolling Windows**: Use two rolling Bloom Filters rotated at token TTL (15 minutes) so expired tokens naturally age out without unbounded bitset saturation.
2. **Cold-start Hydration**: At worker startup, pre-warm active unexpired revocations from Postgres into the current generational filter.

## Consequences

- Legitimate requests are verified locally in V8 memory with zero network I/O.
- Memory overhead is negligible (< 1MB RAM per instance).
- Durable Postgres storage remains the authoritative source of truth.
