# 03 — Database Design (Control Plane)

← [Table of Contents](README.md) · [02 — Request Lifecycle](02-request-lifecycle.md)

> Brief §13.2 listed 13 tables. This design utilizes **5 tables** for D2. Rationales for every pruned table are documented in [§E.5](#e5-eight-tables-cut-from-d2).

## E.1 Conventions

- **PK = Prefixed ULID, `text` type**: `org_01J8…`, `ak_01J8…`, `req_01J8…`. Self-describing in logs and responses, naturally sortable chronologically (excellent index locality), avoids leaking volume metrics unlike auto-incrementing bigints. Generated in the application, never in the DB.
- **Soft delete = `status` column**, no `deleted_at`. Revoked API keys are never physically deleted — required for audit trails.
- **Audit fields**: `created_at` on every table; `updated_at` on mutable tables.
- **Driver: Prisma** — `schema.prisma` is the source of the generated client and of new migration SQL; objects it cannot declare (partial indexes, triggers, `CHECK`, BRIN) stay in SQL migrations, and locking queries use TypedSQL. See [ADR-0088](../../../adr/0088-prisma-for-control-plane-persistence.md).

<a id="e2-ddl"></a>

## E.2 DDL

```sql
CREATE TABLE organizations (
  id                    text PRIMARY KEY,                    -- org_01J...
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','suspended')),
  entitlements          text[] NOT NULL DEFAULT '{}',        -- {writing,speaking}
  rate_limit_rpm        integer NOT NULL DEFAULT 600,
  max_concurrent        integer NOT NULL DEFAULT 20,
  monthly_request_quota integer,                             -- NULL = unlimited
  hard_stop_on_quota    boolean NOT NULL DEFAULT false,      -- see 04 §F.5
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id                   text PRIMARY KEY,                     -- ak_01J...
  organization_id      text NOT NULL REFERENCES organizations(id),
  key_hash             bytea NOT NULL,                       -- sha256(raw), 32 bytes
  key_prefix           text NOT NULL,                        -- 'aihub_sk_a1b2c3', display only
  name                 text NOT NULL,
  scopes               text[] NOT NULL DEFAULT '{}',
  allowed_environments text[] NOT NULL DEFAULT '{production}',
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','revoked')),
  expires_at           timestamptz,
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_hash_uq ON api_keys (key_hash);   -- SOLE lookup path
CREATE INDEX api_keys_org_idx        ON api_keys (organization_id);

CREATE TABLE organization_identity_configs (
  organization_id           text PRIMARY KEY REFERENCES organizations(id),
  issuer                    text NOT NULL,
  jwks_url                  text,
  public_keys_jwks          jsonb,          -- fallback when org does not host JWKS
  allowed_algorithms        text[] NOT NULL DEFAULT '{RS256,ES256}',
  max_assertion_ttl_seconds integer NOT NULL DEFAULT 300,
  status                    text NOT NULL DEFAULT 'active',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (jwks_url IS NOT NULL OR public_keys_jwks IS NOT NULL)
);
CREATE UNIQUE INDEX oic_issuer_uq ON organization_identity_configs (issuer);

CREATE TABLE idempotency_records (
  organization_id     text NOT NULL,
  operation           text NOT NULL,
  idempotency_key     text NOT NULL,
  request_fingerprint bytea NOT NULL,      -- sha256(canonicalJSON(body) + actorId)
  state               text NOT NULL CHECK (state IN ('pending','completed','failed')),
  request_id          text NOT NULL,
  response_status     integer,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  expires_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation, idempotency_key)
);
CREATE INDEX idem_expires_idx ON idempotency_records (expires_at);

CREATE TABLE usage_records (
  request_id        text PRIMARY KEY,                        -- req_01J..., ULID
  organization_id   text NOT NULL,
  api_key_id        text NOT NULL,
  actor_id          text,                                    -- external_user_id
  service           text NOT NULL,
  operation         text NOT NULL,
  environment       text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN
                      ('success','client_error','downstream_error','internal_error')),
  http_status       integer NOT NULL,
  error_code        text,
  billable_requests integer NOT NULL DEFAULT 0 CHECK (billable_requests IN (0, 1)),
  input_tokens      integer,
  output_tokens     integer,
  total_tokens      integer,
  models            jsonb,                                  -- nullable compatibility field; current AI Services omit model identity
  metering_status   text NOT NULL CHECK (metering_status IN
                      ('complete','missing_usage','not_applicable','quota_unverified')),
  total_ms          integer NOT NULL,
  downstream_ms     integer,
  ai_processing_ms  integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_org_time_idx ON usage_records (organization_id, created_at DESC);
CREATE INDEX usage_created_brin ON usage_records USING BRIN (created_at);
```

## E.3 The Four Most Critical Decisions

<a id="1-api-key-hash-bằng-sha-256-không-dùng-bcryptargon2"></a>
<a id="1-api-key-hashed-with-sha-256-not-bcryptargon2"></a>

### 1. API key hashed with SHA-256, NOT bcrypt/argon2

This is where people most frequently make mistakes.

The raw key is 256 bits of CSPRNG randomness — **there is zero dictionary to attack**, so a slow hash adds zero extra security. In exchange, bcrypt burns ~100ms of CPU **per request**; at 50 RPS that constitutes a self-inflicted denial of service. Stripe and GitHub both utilize fast cryptographic hashing for this exact reason.

The resulting mechanics are elegant: `key_hash` is unique → lookup is a **single index seek**, avoiding the "find by prefix then compare hashes one by one" pattern. `key_prefix` serves purely for display on dashboards. Constant-time comparison is also unnecessary, because we look up _by_ hash rather than verifying across candidates.

### 2. Globally UNIQUE `issuer`

Without this constraint, Org B could register Org A's `iss` and sign assertions impersonating A's students. **A single `UNIQUE INDEX` eliminates an entire class of cross-tenant attacks.**

### 3. `metering_status` solves the unfinalized billing dilemma

Record **both**: `billable_requests` is always present, `*_tokens` are present whenever the AI Service reports them.

| Value              | Condition                                                                         |
| ------------------ | --------------------------------------------------------------------------------- |
| `complete`         | AI Service returned complete usage data                                           |
| `missing_usage`    | Operation invokes a model but AI Service failed to return usage                   |
| `not_applicable`   | Reserved for future non-model operations; no current public Writing route uses it |
| `quota_unverified` | Redis was down so quota could not be validated; request was allowed through       |

Never fabricate `0` for missing usage. Doing this now is cheap, but **impossible to reverse later** — last month's dropped data cannot spontaneously regenerate.

### 4. `last_used_at` is not written on every request

At 50 RPS, writing to the same row causes real row lock contention. Only update when older than 1 minute, out-of-band relative to the response cycle, ignoring errors on failure:

```sql
UPDATE api_keys SET last_used_at = now()
WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
```

<a id="e4-xử-lý-race-của-idempotency--không-cần-distributed-lock"></a>
<a id="e4-handling-idempotency-race-conditions-without-distributed-locks"></a>

## E.4 Handling Idempotency Race Conditions — No Distributed Lock

```sql
INSERT INTO idempotency_records (...) VALUES (..., 'pending', ...)
ON CONFLICT (organization_id, operation, idempotency_key) DO NOTHING
RETURNING request_id;
```

| Result                          | Handling                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Returns row (`RETURNING`)       | We are the first requester → proceed with execution                                                   |
| No row, different `fingerprint` | `409 IDEMPOTENCY_CONFLICT`                                                                            |
| No row, `state=completed`       | Replay stored `response_body` with header `Idempotent-Replay: true`                                   |
| No row, `state=pending`         | `409` (in progress). **Do not block/wait** — waiting holds connections and risks cascading starvation |
| No row, `state=failed`          | Permit retry                                                                                          |

Postgres primary keys resolve races natively. **No Redis lock, no Redlock.**

<a id="e5-tám-bảng-bị-cắt-khỏi-d2"></a>
<a id="e5-eight-tables-cut-from-d2"></a>

## E.5 Eight Tables Cut From D2

| Table                                 | Rationale for Removal                                                                                 | Reintroduce When                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `plans`, `subscriptions`              | Business pricing model unfinalized. Creating tables now = designing for a non-existent business model | Pricing is finalized                                       |
| `organization_entitlements`           | Pure list of string tokens with no independent lifecycle → stored as `entitlements text[]`            | Entitlements require independent expiration or attribution |
| `api_key_scopes`                      | Always read alongside key, never queried across entities                                              | Virtually never                                            |
| `routing_rules`, `downstream_configs` | See SSRF discussion below                                                                             | True canary/failover is required                           |
| `quota_configs`                       | 3 columns on `organizations` suffice for Stage A                                                      | Per-operation quotas are needed                            |
| `assets`                              | Required only by Speaking                                                                             | Phase 4                                                    |
| `webhook_endpoints`                   | Required only for async operations                                                                    | Phase 4                                                    |

<a id="vì-sao-routing-catalog-nằm-ở-code-chứ-không-ở-db"></a>
<a id="why-the-routing-catalog-lives-in-code-not-db"></a>

### Why the routing catalog lives in code, not in DB

This is the largest departure from the initial brief. The Operation Catalog and downstream URLs belong in **code + environment variables**:

- Adapters are inherently code. Adding a new AI Service = writing an adapter = deployment. Database configuration **does not prevent deployment**, it merely fragments the source of truth across two places.
- A TypeScript catalog is **type-checked**; a scope mismatch or schema mistake is a compiler error, not a production outage.
- Most importantly: **Downstream URLs in the database introduce an SSRF vector**. Anyone who can write to that table can redirect AIHUB to `169.254.169.254` — and AIHUB carries an internal JWT. Environment variables eliminate that attack surface entirely.

Brief §13.14 explicitly listed "SSRF via configurable downstream URLs" as a threat. The cheapest mitigation is: **do not make downstream URLs configurable via database**.

## E.6 Partitioning and Retention

**Do not partition `usage_records` immediately.** At 50 RPS peak, real volume is ~1–5 million rows/year — Postgres handles this effortlessly with BRIN on `created_at`.

Partitioning trigger: **> ~50 million rows**, or retention pruning jobs taking more than several minutes. Migration involves creating a partitioned table + copying data + swap rename within a maintenance window. Accepting that one-off migration cost is vastly preferable to carrying partitioning complexity throughout year one.

Retention:

| Table                 | Retention Period | Rationale                                |
| --------------------- | ---------------- | ---------------------------------------- |
| `usage_records`       | 13 months        | Allows year-over-year billing comparison |
| `idempotency_records` | 24 hours         | Per D1 §26 specification                 |

A single nightly `DELETE` cron job; no dedicated job scheduler required.

---

→ Next: [04 — Redis](04-redis.md)
