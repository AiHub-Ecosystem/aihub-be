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

| ADR                                                       | Title                                                            | Status                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| [0001](0001-nestjs-fastify-single-application.md)         | NestJS + Fastify as one application, no separate data plane      | Accepted                                    |
| [0002](0002-postgresql-control-plane-pruned-tables.md)    | PostgreSQL control plane with a pruned table set                 | Accepted                                    |
| [0003](0003-api-keys-sha256-not-slow-hash.md)             | API keys use SHA-256 hashes, not bcrypt/argon2                   | Accepted                                    |
| [0004](0004-signed-user-assertions-jwks.md)               | Signed User Assertions verified against per-organization JWKS    | Accepted; amended by ADR-0053               |
| [0005](0005-internal-eddsa-jwt.md)                        | Internal EdDSA JWT for AIHUB-to-AI-service authentication        | Accepted                                    |
| [0006](0006-redis-scoped-role-fail-open.md)               | Redis has a scoped role and fails open where blocking costs more | Accepted; graded routes amended by ADR-0116 |
| [0007](0007-postgres-idempotency-no-distributed-locks.md) | Postgres-backed idempotency without distributed locks            | Accepted                                    |
| [0008](0008-operation-catalog-in-code.md)                 | The operation catalog lives in code, not in the database         | Accepted                                    |
| [0009](0009-pure-downstream-adapters.md)                  | Downstream adapters are pure functions without I/O               | Accepted                                    |
| [0010](0010-meter-requests-and-tokens.md)                 | Meter both request counts and token metrics from day one         | Accepted                                    |
| [0011](0011-docker-compose-single-vps.md)                 | Docker Compose on a single VPS with documented exit triggers     | Accepted; see ADR-0085 and ADR-0165         |
| [0012](0012-defer-distributed-tracing.md)                 | Defer distributed tracing in Stage A                             | Superseded by ADR-0063                      |
