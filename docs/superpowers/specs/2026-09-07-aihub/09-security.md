# 09 — Security Threat Model

← [Table of Contents](README.md) · [08 — Metering & Observability](08-metering-and-observability.md)

## M.1 Threat Model Matrix

| #   | Threat                                            | Priority | Mitigation                                                                                                                                                                                                                                                                                                       | Documented In                                                                                                                                         |
| --- | ------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API key leakage                                   | Must     | `aihub_sk_` prefix for secret scanners; instantaneous revocation (cache purge); `last_used_at` telemetry                                                                                                                                                                                                         | [05 §G.1–G.2](05-auth-identity.md#g1-api-key-format-and-generation)                                                                                   |
| 2   | Key brute-forcing                                 | Must     | 256-bit entropy + per-IP failed authentication tracking                                                                                                                                                                                                                                                          | [05 §G.3](05-auth-identity.md#g3-brute-force-protection)                                                                                              |
| 3   | **Assertion forgery / cross-tenant**              | Must     | `iss` must match organization identified via API key + `UNIQUE(issuer)` constraint                                                                                                                                                                                                                               | [03 §E.2](03-database.md#e2-ddl), [05 §G.4](05-auth-identity.md#g4-user-assertion-verification-rules)                                                 |
| 4   | **JWT algorithm confusion**                       | Must     | Allowlist `alg` per organization; strictly reject `none` and `HS*`                                                                                                                                                                                                                                               | [05 §G.4](05-auth-identity.md#g4-user-assertion-verification-rules)                                                                                   |
| 5   | Overly long-lived assertions                      | Must     | `max_assertion_ttl_seconds` (defaults to 300)                                                                                                                                                                                                                                                                    | [05 §G.4](05-auth-identity.md#g4-user-assertion-verification-rules)                                                                                   |
| 6   | **SSRF via `jwks_url`**                           | Must     | https enforced + private IPs blocked + **redirects rejected** + strict timeouts + size caps                                                                                                                                                                                                                      | [05 §G.5](05-auth-identity.md#g5-jwks-fetch-blocking-ssrf)                                                                                            |
| 7   | **SSRF via downstream URLs**                      | Must     | Downstream URLs stored in environment variables, never in DB; adapters only know relative `path`                                                                                                                                                                                                                 | [03 §E.5](03-database.md#why-the-routing-catalog-lives-in-code-not-db), [06 §H.3](06-routing-adapter.md#h3-adapters-pure-functions-zero-io)           |
| 8   | Secret / PII leakage in logs                      | Must     | Centralized redaction list + automated test verification                                                                                                                                                                                                                                                         | [08 §L.1](08-metering-and-observability.md#never-logged)                                                                                              |
| 9   | Large payloads causing OOM / DoS                  | Must     | `maxBodyBytes` enforced per operation                                                                                                                                                                                                                                                                            | [06 §H.1](06-routing-adapter.md#h1-operation-catalog-typed-code)                                                                                      |
| 10  | DoS via expensive model requests                  | Must     | Rate limits + concurrency limits + monthly quotas                                                                                                                                                                                                                                                                | [04 §F.2–F.4](04-redis.md#f2-rate-limit-fixed-window-without-lua)                                                                                     |
| 11  | **AI Service reachable from public Internet**     | Should   | Security boundary enforced via **credentials** rather than network isolation — see §M.3                                                                                                                                                                                                                          | [§M.3](#m3-ai-writing-remains-public-conditionally-accepted-risk)                                                                                     |
| 11b | **Unauthenticated public endpoint on downstream** | **Must** | Lock down `/five-minute-grading`                                                                                                                                                                                                                                                                                 | [01 §0.1](01-context-and-stack.md#two-security-issues-on-the-live-production-service)                                                                 |
| 12  | IDOR between students / actors                    | Must     | User identity propagated exclusively via signed internal JWT, **never via request body**                                                                                                                                                                                                                         | [06 §H.3](06-routing-adapter.md#real-adapters-written-from-fixtures-not-speculation)                                                                  |
| 13  | Cross-service internal JWT replay                 | Should   | Distinct per-service `aud` target claim, TTL 60s                                                                                                                                                                                                                                                                 | [05 §G.7](05-auth-identity.md#g7-internal-jwt-aihub-to-ai-service)                                                                                    |
| 14  | Assertion replay attacks                          | Should   | Mandate `jti` in contract schema; toggle verification check when required                                                                                                                                                                                                                                        | [05 §G.6](05-auth-identity.md#g6-replay-protection-deferred-from-d2)                                                                                  |
| 15  | AIHUB signing key compromise                      | Should   | 5-step key rotation runbook, 3-month rotation cycle                                                                                                                                                                                                                                                              | [05 §G.8](05-auth-identity.md#g8-aihub-jwks-and-key-rotation)                                                                                         |
| 16  | mTLS between AIHUB ↔ AI Service                   | Later    | Private networking + internal signed JWTs suffice for Stage A                                                                                                                                                                                                                                                    | —                                                                                                                                                     |
| 17  | HashiCorp Vault for secrets                       | Later    | `.env` with permissions `chmod 600` until reaching ≥ 3 environments                                                                                                                                                                                                                                              | [05 §G.9](05-auth-identity.md#g9-secrets)                                                                                                             |
| 18  | Webhook SSRF / replay                             | Later    | Handled when building async capabilities                                                                                                                                                                                                                                                                         | Phase 4                                                                                                                                               |
| 19  | **Environment spoofing via `Host` header**        | Must     | `resolveAihubEnvironment` trusts client `Host` header — upstream reverse proxy/LB **must** validate/override `Host` to match true domain before forwarding to AIHUB. Application layer enforces `assertHostConfigurationIsSafe()` to halt boot if production is missing or configured hostnames are placeholders | [05 §G.11](05-auth-identity.md#g11-host-header-is-not-an-absolute-source-of-truth), `src/modules/identity/shared/presentation/request-environment.ts` |

## M.2 Why the Bolded Threats Are More Dangerous

Threats 3, 4, 6, 7, 11b, and 12 fail **silently**. There are zero alarms — no errors, no alert pings, no abnormal logs — until one organization's data has leaked into another tenant's account, or AIHUB has been weaponized as an internal network port scanner.

That is why their mitigations are **deliberately woven across the core architecture** rather than isolated into an abstract "security module":

- `UNIQUE(issuer)` is a single constraint line in Postgres DDL
- Algorithm allowlists are a single guard statement in token verification
- Blocking redirects is an undici client configuration flag
- Downstream URLs stored in environment variables is a configuration design choice
- Omitting `actorId` from request bodies is a line deliberately _not_ written in adapters

Effective security here consists of small, precise design choices placed in the right spots, not bloated middleware abstractions.

<a id="m3-ai-writing-còn-public--rủi-ro-được-chấp-nhận-có-điều-kiện"></a>
<a id="m3-ai-writing-remains-public-conditionally-accepted-risk"></a>

## M.3 AI Writing Remains Public — Conditionally Accepted Risk

`api-ielts-writing.aihubproduction.com` currently resolves over the public Internet and **will continue to do so for some time**: Writing serves an active external client (Wispace) that has not yet migrated through AIHUB. Decommissioning its public interface depends on their roadmap, not AIHUB's.

### The Security Boundary Is Credentials, Not Network Isolation

This is where hasty architectural conclusions mislead. The claim that "the service is public, so anyone can bypass AIHUB" **is false** — Writing still mandates `HTTPBearer` authentication. Bypassing AIHUB requires **holding a valid Writing token**.

```
AIHUB Customer  --(AIHUB API key)-->  AIHUB  --(Writing token)-->  Writing
Wispace         --(Writing token)------------------------------->  Writing
```

AIHUB customers hold only AIHUB API keys. They **do not possess** Writing tokens, so they cannot bypass the gateway — regardless of whether Writing's port is reachable. The only clients calling Writing directly are internal applications.

Therefore, AIHUB's rate limits, quotas, and metering **remain completely effective** across all AIHUB customers.

### Three Non-Negotiable Conditions to Accept This Exposure

| #   | Condition                                                          | Nature                                        |
| --- | ------------------------------------------------------------------ | --------------------------------------------- |
| 1   | Writing tokens are **never** issued to AIHUB customers             | Operational process                           |
| 2   | AIHUB uses a **dedicated token**, completely distinct from Wispace | Technical requirement, provisioned by Writing |
| 3   | **Every** endpoint on Writing mandates authentication              | Technical defect, currently missing           |

Condition 1 is the most fragile because it is operational, not technical — a single casual "let the customer call Writing directly for testing" breaks the entire model. Must be strictly codified in onboarding SOPs.

Condition 2 provides two tangible benefits: AIHUB usage metrics remain isolated from Wispace, and credentials can be revoked independently upon compromise.

### Condition 3 Is Urgent — `/five-minute-grading`

In OpenAPI documentation, every endpoint declares `HTTPBearer` **except** `/five-minute-grading`, which has no security definition.

On an isolated private network, that is a minor gap. On the **public Internet**, that represents an unauthenticated LLM invocation endpoint open to the entire world, billed to our credit card. This is the single highest-priority vulnerability across the entire infrastructure — and the fix lives in the Writing service, not AIHUB.

### Path to Private Network Isolation

When Wispace completes its migration to call through AIHUB, isolating Writing onto a private VPC becomes a straightforward operational step. The gateway design remains completely unchanged — it simply layers network topology defense on top of the credential boundaries already in place.

## M.4 Deferred Threats and Rationales

| Threat                                      | Why Accepted in Stage A                                                                       | Revisit Trigger                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Attacker uses Writing token to bypass AIHUB | Only internal applications possess Writing tokens; customers have none                        | Third parties granted direct Writing tokens, or Wispace migrates to AIHUB           |
| Lack of mTLS between AIHUB ↔ AI Service     | Private VPC network + internal signed JWTs resolve both "which service" and "on whose behalf" | Multi-tenant shared infrastructure or enterprise compliance audits                  |
| Assertion replay                            | Backend-to-backend TLS; an attacker intercepting traffic already possesses the raw API key    | Specific customer contractual demand, or assertions transported over untrusted hops |
| SSRF via Task 1 `image_url`                 | Image retrieval occurs inside **Writing**, not AIHUB                                          | Transition to `asset_id` in Phase 4, or enforce private IP blocks inside Writing    |
| Per-IP rate limiting for valid requests     | Per-org and per-key rate limits are significantly more precise                                | Coordinated distributed attack utilizing compromised valid keys                     |
| Web Application Firewall (WAF)              | Payloads are strictly schema-validated JSON with zero SQL/HTML interpretation                 | Endpoints introduced that accept rich text or SQL-like DSLs                         |

---

→ Next: [10 — Deployment & Roadmap](10-deployment-roadmap.md)
