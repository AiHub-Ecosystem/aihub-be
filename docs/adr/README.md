# Architecture Decision Records

Sequential immutable log. Numbering is continuous; never renumber or reuse an
identifier. Each file carries its own `Status:` line; accepted decisions are
replaced by a successor that links back, never by editing history away.

## Numbering note: 0001–0012

ADRs 0001–0012 were decided on 2026-09-07 inside the implementation
specification suite
([10-deployment-roadmap §O](../superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md))
but never written up as files. The first file recorded was
[0013](0013-vault-runtime-secret-management.md), which took the next number.
This gap is intentional: the numbers stay reserved for those decisions, and
[the retroactive records](0001-nestjs-fastify-single-application.md)
(added 2026-11-07) now occupy them. Do not renumber 0013 onward.

| ADR                                                             | Title                                                                   | Status                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| [0001](0001-nestjs-fastify-single-application.md)               | NestJS + Fastify as one application, no separate data plane             | Accepted                                       |
| [0002](0002-postgresql-control-plane-pruned-tables.md)          | PostgreSQL control plane with a pruned table set                        | Accepted                                       |
| [0003](0003-api-keys-sha256-not-slow-hash.md)                   | API keys use SHA-256 hashes, not bcrypt/argon2                          | Accepted                                       |
| [0004](0004-signed-user-assertions-jwks.md)                     | Signed User Assertions verified against per-organization JWKS           | Accepted; amended by ADR-0053                  |
| [0005](0005-internal-eddsa-jwt.md)                              | Internal EdDSA JWT for AIHUB-to-AI-service authentication               | Accepted                                       |
| [0006](0006-redis-scoped-role-fail-open.md)                     | Redis has a scoped role and fails open where blocking costs more        | Accepted; graded routes amended by ADR-0116    |
| [0007](0007-postgres-idempotency-no-distributed-locks.md)       | Postgres-backed idempotency without distributed locks                   | Accepted                                       |
| [0008](0008-operation-catalog-in-code.md)                       | The operation catalog lives in code, not in the database                | Accepted                                       |
| [0009](0009-pure-downstream-adapters.md)                        | Downstream adapters are pure functions without I/O                      | Accepted                                       |
| [0010](0010-meter-requests-and-tokens.md)                       | Meter both request counts and token metrics from day one                | Accepted                                       |
| [0011](0011-docker-compose-single-vps.md)                       | Docker Compose on a single VPS with documented exit triggers            | Accepted; see ADR-0085 and ADR-0165            |
| [0012](0012-defer-distributed-tracing.md)                       | Defer distributed tracing in Stage A                                    | Superseded by ADR-0063                         |
| [0013](0013-vault-runtime-secret-management.md)                 | Vault-backed runtime secret management                                  | Accepted; amended by ADR-0171                  |
| [0171](0171-vault-runtime-login-requires-a-secret-id.md)        | Vault runtime login requires a Secret ID as well as the role ID         | Accepted; supersedes ADR-0170                  |
| [0172](0172-writing-priority-errors-in-v2-grading.md)           | Publish provider-ranked Writing priority errors in `/v2`                | Accepted; amends ADR-0143; amended by ADR-0177 |
| [0173](0173-gateway-prioritized-load-shedding.md)               | The gateway sheds load by request tier and keeps the tier local         | Accepted                                       |
| [0174](0174-bounded-uncached-api-key-lookups.md)                | Bound uncached API-key lookups across the deployment                    | Accepted; amends ADR-0006 and ADR-0114         |
| [0175](0175-single-use-environment-bound-user-assertions.md)    | Make Signed User Assertions single-use per Organization and environment | Accepted; amends ADR-0006                      |
| [0176](0176-dpop-binds-web-session-jwts.md)                     | DPoP binds Web Session User Access JWTs to a client key                 | Accepted; amends ADR-0022                      |
| [0177](0177-sanitize-and-bound-ai-service-grading-responses.md) | Sanitize and bound AI Service grading responses                         | Accepted; amends ADR-0143 and ADR-0172         |
| [0178](0178-registration-may-confirm-an-active-account.md)      | Registration may confirm that an email has an active account            | Accepted; amends ADR-0022 and ADR-0123         |
| [0179](0179-constrain-the-production-deploy-identity.md)        | Constrain the production deploy identity                                | Accepted; implementation pending               |
| [0180](0180-speaking-priority-errors-in-v2.md)                  | Publish Speaking priority errors in `/v2`                               | Accepted                                       |
| [0181](0181-scalar-renderer-1-83.md)                            | Scalar renderer 1.83.0                                                  | Accepted                                       |
| [0182](0182-security-reads-use-postgres-writer.md)              | Keep security decisions on the PostgreSQL writer                        | Accepted; implementation pending               |
| [0183](0183-explicit-request-context-stays-the-default.md)      | Keep explicit request context as the default                            | Accepted                                       |
