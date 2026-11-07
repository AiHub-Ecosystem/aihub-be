# ADR-0001: NestJS + Fastify as one application, no separate data plane

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

AIHUB enforces organization policy, metering, and identity verification before
dispatching to private AI services. A dedicated proxy data plane (Envoy, Kong)
or a bare framework would move that policy out of the application.

## Decision

AIHUB is one NestJS application on a Fastify adapter. Host nginx terminates TLS
only; there is no separate proxy data plane. NestJS was chosen over bare
Fastify, Express, and Go frameworks because its modules map one-to-one to the
target architecture and a long-lived product with multiple maintainers benefits
from DI and enforced architectural boundaries.

Direction B (Kong/Envoy as data plane plus AIHUB as control plane) was
rejected: Kong knows nothing about `entitlement ∩ api_key_scope`, cannot verify
assertions against per-organization JWKS, and would need custom Lua plugins per
feature — a rewrite of the application in an inferior language, plus its own
database. For a 2–3 person team without DevOps, two configuration systems is
fatal.

## Consequences

- All admission logic lives in application code and is type-checked and tested
  there; the proxy layer carries no policy.
- Node is single-threaded, so multi-core utilization requires multiple
  instances; at the Stage A load profile AI requests are I/O-bound, so this is
  acceptable.
- Fastify executes JSON Schema natively, which is why validation schemas are
  compiled TypeBox definitions shared with OpenAPI generation.
