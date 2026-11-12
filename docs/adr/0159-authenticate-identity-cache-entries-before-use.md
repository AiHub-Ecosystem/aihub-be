# ADR-0159: Authenticate identity cache entries before use

- Status: Accepted — approved during #349 grooming on 2026-11-09
- Date: 2026-11-09
- Related: [#349](https://github.com/AiHub-Ecosystem/aihub-be/issues/349), [#348](https://github.com/AiHub-Ecosystem/aihub-be/issues/348), [#583](https://github.com/AiHub-Ecosystem/aihub-be/issues/583), [#75](https://github.com/AiHub-Ecosystem/aihub-be/issues/75), [ADR-0013](0013-vault-runtime-secret-management.md), [ADR-0085](0085-per-tier-blue-green-cutover.md), [ADR-0114](0114-bounded-identity-cache-tiers.md), [ADR-0125](0125-bounded-protection-metrics.md), [ADR-0128](0128-persisted-values-and-vault-document-keys-are-read-before-they-are-written.md)

## Context

AIHUB caches API-key authorization records and Organization JWKS entries in
Redis. Redis is an ephemeral cache, not an authorization source. A party able
to write Redis can replace a well-formed entry and influence authorization or
which key verifies a Signed User Assertion unless AIHUB authenticates each
entry before use.

Current public API-key guards force a durable read, so the API-key cache is not
consumed by a current public request path. The JWKS cache is actively used.
Keeping API-key cache integrity at the store boundary prevents a later caller
from reintroducing trust in unsigned values.

## Decision

1. **Authenticate each shared entry.** Store an envelope whose HMAC-SHA-256
   covers the format version, cache kind, exact Redis key, complete entry, and
   its freshness deadlines. Use one cryptographically random key per
   deployment environment, shared by every AIHUB process in that environment.
   Vault-backed deployment environments receive their key through the Vault
   runtime-secret boundary; development and tests use an explicit environment
   source. Never expose the key in logs, errors, or metrics.

2. **Fail closed on unverified Redis values.** A missing or invalid MAC is
   deleted and treated as a cache miss. If a process starts without the key,
   it bypasses Redis identity reads and writes and uses the existing trusted
   local or authoritative-source path; it does not read or write unsigned
   Redis entries. Invalidation is not an unsigned entry write: a keyless
   process still advances the shared JWKS generation and purges its local
   entry, because otherwise an identity-config update would not stop a
   stale local JWKS from being trusted. API-key misses use Postgres. JWKS
   misses use the existing key provider path. Every successful identity-config
   save also advances the durable `jwks_cache_version`, including an unchanged
   retry, so a Redis writer cannot replay an entry by restoring its generation.
   The verification result keeps `authenticated` and `data` separate, so a
   genuinely `undefined` payload is
   not confused with an unauthenticated entry.

3. **Authenticate original freshness.** The signed entry carries an absolute
   freshness deadline. Redis storage expiry may shorten, but never extend, that
   deadline; replaying an old entry cannot reset it. API-key entries remain
   within the positive-cache ceiling in ADR-0114 (60 seconds). JWKS entries
   retain their ADR-0114 fresh and stale ceilings (15 minutes and 24 hours).

4. **Measure integrity rejection with bounded labels.** Emit a counter with
   only the cache kind (`api_key` or `jwks`). Do not label it with an
   Organization, API-key identifier or hash, Redis key, payload, or MAC. Alert
   thresholds belong to [#412](https://github.com/AiHub-Ecosystem/aihub-be/issues/412).

5. **Rotate one active key at a time.** There is no previous-key grace period.
   Changing the key makes entries signed by the old key miss and rebuild from
   their source. During a rolling restart, old and new processes may reject
   each other's entries, causing additional source reads until the old
   processes drain. If the key is compromised, drain all processes using it
   before treating rotation as complete.

6. **Roll out the reader before the Vault document key.** Following ADR-0128,
   first deploy a reader that accepts the new key as optional and bypasses
   Redis when it is absent. Only a later release adds the key to the Vault
   Agent template and rendered document. The integrity guarantee is active
   only when every serving process either verifies entries or bypasses Redis.
   A rollback may target only a reader-capable release; a pre-reader version
   must not return to service while identity entries remain readable.

## Consequences

- A Redis writer without the runtime key cannot forge an entry that a
  key-enabled AIHUB process accepts.
- Initial activation and key rotation can cause cache misses and extra source
  reads. If the JWKS source is unavailable and a process has no usable local
  entry, assertion verification may fail until keys can be fetched.
- The version advance on an unchanged save applies only to processes that run
  this release. While a pre-release image can still save an identical
  configuration during a blue/green cutover, that save leaves the version
  unchanged and the JWKS replay window stays open until the older image drains.
  The unchanged-save advance changes `jwks_cache_version` and `updated_at` but
  not `revision`, so ETags and the audit trail are unaffected.
- This integrity check does not isolate Redis or protect its availability.
  Redis isolation remains tracked by [#348](https://github.com/AiHub-Ecosystem/aihub-be/issues/348)
  and [#583](https://github.com/AiHub-Ecosystem/aihub-be/issues/583).
- This ADR records the decision, not implementation evidence. Issue #349 stays
  open until its adversarial cache, freshness, rollout, and verification
  criteria pass.
