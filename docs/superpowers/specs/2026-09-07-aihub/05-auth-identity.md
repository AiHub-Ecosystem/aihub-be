# 05 — Auth & Identity Design

← [Table of Contents](README.md) · [04 — Redis](04-redis.md)

> This is the only file across this specification suite that deliberately **does not** apply the "do as little as possible" heuristic. Auth mistakes have no cheap recovery path.

<a id="g1-format-và-sinh-api-key"></a>
<a id="g1-api-key-format-and-generation"></a>

## G.1 API Key Format and Generation

```
aihub_sk_ + base62(32 bytes CSPRNG)
        -> aihub_sk_7Kq2mXvR9wLpN4tYbZ3sHgD8fJc1AeQ6
```

- **32 bytes = 256 bits of entropy.** Brute-force is computationally impossible — this forms the bedrock for our fast hash decision in [03 §E.3](03-database.md#1-api-key-hashed-with-sha-256-not-bcryptargon2).
- **Fixed `aihub_sk_` prefix** enables automated secret scanners (GitHub, GitLab, Trufflehog) to flag keys accidentally committed by customers.
- **Do not** embed `live`/`test` in the key token. Environment is determined strictly by hostname (target architecture §7); embedding environment in keys creates dual sources of truth.

### CLI Onboarding

The Admin API is deferred (team design decision), so onboarding is performed via CLI:

```bash
pnpm cli org:create --name "Acme Edu" --entitlements writing

pnpm cli key:create --org org_01J8... --name "Prod backend" \
                    --scopes writing.grade \
                    --envs production
# -> prints raw key EXACTLY ONCE to stdout; never logged, never written to disk

pnpm cli key:revoke   --key ak_01J8...

pnpm cli identity:set --org org_01J8... --issuer https://acme.edu \
                      --jwks-url https://acme.edu/.well-known/jwks.json
```

This CLI is **production code**, not disposable throwaway scripts — the future admin API will invoke the exact same underlying application services.

<a id="g2-lookup-flow"></a>

## G.2 Lookup Flow

```ts
const hash = sha256(rawKey); // 32 bytes, ~1µs

// 1. Redis: aihub:v1:key:<hex>  TTL 60s — caches both HIT and MISS
// 2. miss -> SELECT ... WHERE key_hash = $1        (1 index seek)
// 3. validate: status='active' ∧ (expires_at IS NULL ∨ > now())
//              ∧ env ∈ allowed_environments ∧ org.status='active'
```

**Negative caching is mandatory.** Without it, an attacker spamming fictitious keys turns every incoming request into a Postgres index seek. With negative caching, invalid keys hit only Redis.

**60s TTL is the acceptable cost of deferring the Admin API** — revoking a key can take up to 60 seconds to propagate. This is acceptable, but the CLI `key:revoke` command must proactively purge the cache key to make revocation instantaneous:

```ts
await redis.del(`aihub:v1:key:${hex(hash)}`); // ~2 lines, completely eliminates the 60s exposure window
```

<a id="g3-chống-brute-force"></a>
<a id="g3-brute-force-protection"></a>

## G.3 Brute-Force Protection

```
Redis: aihub:v1:authfail:<ip>   INCR, TTL 300s
>= 20 FAILURES / 5 minutes      -> 429
```

**Only failures are counted.** Valid requests never touch this counter, ensuring legitimate customers firing 50 RPS from a single NAT gateway are never penalized.

<a id="g4-user-assertion--verify-cái-gì"></a>
<a id="g4-user-assertion-verification-rules"></a>

## G.4 User Assertion — Verification Rules

> **Amended by [ADR-0053](../../../adr/0053-optional-user-identity-verification.md) (2026-09-26).** Verification is optional per Organization. `X-User-Identity` carries a Signed User Assertion only when the Organization has an **active** identity configuration; the rules below apply to that form, and a plain value is rejected rather than downgraded. Without an active configuration, the value is a **Declared User ID** accepted unsigned. Both forms resolve to one End-User ID with one rule, which also binds `sub`: 1–256 characters in `0x21`–`0x7E`, compared exactly as sent. A configuration-store or JWKS failure stays `503 IDENTITY_PROVIDER_UNAVAILABLE` and never falls back to the declared form.

```
Deliberate order: cheap checks first, cryptography last.

1. decode header  -> alg ∈ config.allowed_algorithms   # REJECT 'none', REJECT HS*
2. payload.aud === 'aihub'
3. payload.iss === identityConfig.issuer               # matches org identified from API key
4. exp > now - skew(60s)  ∧  iat < now + skew(60s)
5. (exp - iat) <= max_assertion_ttl_seconds
6. jti is present                                      # logged for now, see G.6
7. verify cryptographic signature via org's JWKS       # expensive crypto at the end
```

**Step 1 blocks algorithm confusion.** This is the classic JWT vulnerability: token declares `alg: HS256`, the library uses the RSA public key as an HMAC secret — and since public keys are public, anyone can forge tokens trivially. Only accept algorithms explicitly allowlisted for _that specific organization_, and enforce key-type / algorithm matching.

**Step 3 is the cross-tenant firewall.** If the API key belongs to Org A, but the assertion asserts `iss` of Org B → `403`. Combined with `UNIQUE(issuer)` in [03 §E.2](03-database.md#e2-ddl), Org B cannot register Org A's issuer in the first place.

**Step 5 is an addition relative to D1.** Without TTL caps, a customer could sign an assertion with a 5-year `exp` and hardcode it into a mobile app — effectively leaking a permanent API key. `max_assertion_ttl_seconds` defaults to 300, configured in the DB so it can be tuned per tenant.

**Org-scoped operations where client sends assertion anyway: still verify.** If present, it must be valid. Silently ignoring an invalid assertion masks integration bugs. Reserved: no operation is organization-scoped today, so the catalog does not model this scope; the first such operation reintroduces it with a guard test (#168).

<a id="g5-jwks-fetch--chặn-ssrf"></a>
<a id="g5-jwks-fetch-blocking-ssrf"></a>

## G.5 JWKS Fetch — Blocking SSRF

`jwks_url` is supplied by the customer, and AIHUB fetches it autonomously. Without rigorous controls, AIHUB becomes an internal network port scanner.

```
Mandatory pre-flight checks before every fetch:
- scheme === 'https'
- DNS resolved first; reject if IP ∈ {private, loopback, link-local, CGNAT}
  strictly block 169.254.169.254 (cloud metadata endpoint)
- BLOCK REDIRECTS (maxRedirections: 0)
- timeout 3s, response size capped at 64KB
- never attach any credentials or headers
```

**Blocking redirects is frequently omitted:** if you validate the IP and then follow redirects, the customer's server simply responds with `302 -> 169.254.169.254`, bypassing IP validation entirely.

### Caching Strategy

```
aihub:v1:jwks:<org_id>  TTL 15 minutes
unknown kid  -> refetch once, at most 1 refetch / 5 minutes / org (prevents DoS via fake kids)
fetch fails but stale cache exists -> SERVE stale cache for up to 24 hours
fetch fails and no cache exists    -> 503 IDENTITY_PROVIDER_UNAVAILABLE
```

Serving stale keys during upstream outages is **secure** — public keys do not spontaneously turn malicious — and keeps AIHUB available when customer identity providers suffer transient failures.

> `IDENTITY_PROVIDER_UNAVAILABLE` was absent from D1's initial error matrix. It must be added: this is neither a client credential fault (a 401 would prompt futile key rotation) nor an AI Service failure.

<a id="g6-replay-protection--không-làm-ở-d2"></a>
<a id="g6-replay-protection-deferred-from-d2"></a>

## G.6 Replay Protection — NOT in D2

**Rationale:** Assertions have a 5-minute lifespan and travel alongside the API key over TLS in a backend-to-backend connection. Replaying requires having intercepted the transport traffic — at which point the attacker already holds the raw API key, rendering assertion replay the least of our worries.

**Cost if built:** Redis `jti` sets for every request, adding an extra round-trip to the hot path, plus the dilemma of "fail open or closed when Redis is down".

**However, the contract MUST mandate `jti` in D1**, and AIHUB logs it. That way, when replay protection is needed for high-compliance tenants, it can be enabled via a single `SET NX` — **without forcing every existing customer to update their client code**.

<a id="g7-internal-jwt-aihub--ai-service"></a>
<a id="g7-internal-jwt-aihub-to-ai-service"></a>

## G.7 Internal JWT: AIHUB → AI Service

```json
{ "alg": "EdDSA", "kid": "aihub-2026-01" }
{
  "iss": "aihub", "aud": "ai-writing",
  "org_id": "org_01J8...", "sub": "student_456",
  "scope": ["writing.grade"],
  "iat": 1788350000, "exp": 1788350060,
  "jti": "req_01J8..."
}
```

- **EdDSA (Ed25519)** instead of RS256: signs in ~50µs vs ~1ms, produces much smaller tokens. Native verification available across Node/Python/Go; the team controls both ends of the wire, eliminating compatibility barriers. Header includes `kid` + `alg` for graceful fallback to RS256 if needed by third-party services.
- **`jti` = `request_id`** — zero cost, establishes unified distributed tracing between AIHUB and the AI Service.
- **Per-service `aud` targeting:** tokens minted for `ai-writing` cannot be accepted by `ai-speaking`. If `ai-writing` is compromised, it cannot pivot and call `ai-speaking`.
- **TTL 60s**, minted just-in-time, never stored in DB, no refresh tokens.

<a id="g8-jwks-của-aihub--xoay-khoá"></a>
<a id="g8-aihub-jwks-and-key-rotation"></a>

## G.8 AIHUB JWKS & Key Rotation

```
GET https://api.aihub.example.com/.well-known/jwks.json     # public, contains public keys only
AI Services cache for 1 hour; unknown kid triggers refetch (rate-limited as in G.5)
```

Zero-downtime key rotation procedure without synchronized deployments:

```
1. Generate new keypair -> publish new PUBLIC key to JWKS, continue SIGNING with old key
2. Wait > 1 hour (ensuring all downstream AI services refresh cache)
3. Switch gateway to SIGN with new key
4. Wait > 2 minutes (all 60s TTL tokens signed by old key have expired)
5. Remove old public key from JWKS
```

Executed every 3 months, or immediately upon suspected compromise. This rotation workflow **must have automated test coverage** — see [10 §N.7](10-deployment-roadmap.md#n7-testing-strategy).

<a id="g9-secret"></a>
<a id="g9-secrets"></a>

## G.9 Secrets Management

Stage A, no DevOps team → **do not deploy Vault**. Private keys and DB credentials reside in `.env` mounted into containers, with permissions `chmod 600`, never checked into git, backed up manually out-of-band off the server.

Trigger to deploy Vault/SOPS: **≥ 3 environments**, or **team member departure** requiring credential rotation, or **formal compliance requirements**. Until then, Vault is merely another moving part that can fail at 3 AM.

<a id="g10-authorization"></a>

## G.10 Authorization

```ts
effectiveScopes = apiKey.scopes.filter(
  (s) => org.entitlements.includes(s.split(".")[0]) // 'writing.grade' -> 'writing'
);
if (!effectiveScopes.includes(operation.requiredScope))
  throw new ForbiddenError();
```

All necessary metadata is already in memory from the initial key lookup → **zero extra database queries**. Conforms strictly to the `Entitlement ∩ Key Scope` principle from target architecture §10.

**Fail-closed:** Empty entitlements → zero permissions. Empty key scopes → zero permissions. No branch ever defaults to open.

<a id="g11-host-header-không-phải-nguồn-tin-cậy-tuyệt-đối"></a>
<a id="g11-host-header-is-not-an-absolute-source-of-truth"></a>

## G.11 Host Header Is Not an Absolute Source of Truth

`resolveAihubEnvironment` determines `production`/`staging`/`development`/`sandbox` by matching the incoming `Host` header against the corresponding `AIHUB_*_HOST` settings. Production is required; staging, development, and sandbox are optional and are absent from the host map when unset. However, `Host` is a client-supplied header — inherently self-asserted, just like a custom `X-Environment` header.

Consequence: If the reverse proxy/LB in front of a deployment **fails to validate** that the `Host` matches its own actual domain, a client connecting directly to that deployment (bypassing DNS via IP) could send `Host: <domain of another tier>`, causing AIHUB to resolve the incorrect environment — undermining the premise that clients cannot dictate environments (US01).

Two defensive layers, neither sufficient alone:

1. **Infrastructure (Mandatory, outside AIHUB codebase).** The reverse proxy/LB in front of each environment must validate or overwrite `Host` to match its authentic domain / TLS SNI before forwarding requests to AIHUB. This is an operational requirement — AIHUB code cannot verify whether the TCP connection arrived at the intended domain.
2. **Code (`assertHostConfigurationIsSafe()`).** Halts application bootstrap in non-development environments if the required production host is missing or any configured host remains a default placeholder (`api.aihub.example.com`, etc.) — since placeholders are public knowledge and leaving them open invites spoofing. This guard catches "forgotten configuration", but **cannot catch** upstream reverse-proxy misconfiguration — which remains the responsibility of layer 1.

---

→ Next: [06 — Routing & Adapter](06-routing-adapter.md)
