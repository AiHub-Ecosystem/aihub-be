# Restricted cross-module edges carry their own rules

Amends: [ADR-0106](0106-cross-module-imports-are-forbidden-outside-published-seams.md) on which seams a high-volume cross-module edge may cross.

ADR-0106 gives every module pair one seam set: the module composition root, `application/**.port.ts` contracts, a presentation primitive declaring `module 'fastify'`, a Nest `exports:` declaration, a `public/` facade, or a Nest decorator. Two edges carry enough traffic that this set is wider than they should be allowed to grow, and one module holds an edge that must stay at zero.

Three rules in `.dependency-cruiser.cjs` (#1733), reported beside the general rule and never instead of it:

- `no-identity-auth-internal-import`: identity reaches auth only through the module file, application ports, `public/` facades, Nest exports, and Nest decorators. The shared Fastify request primitive is not offered on this edge. Every existing import already crosses through one of the stated seams, so no file moved and no exception was recorded.
- `no-business-to-gateway-internal-import`: writing and speaking reach gateway through the same narrowed set. Existing imports cross through `public/graded-pipeline`, `operation-dispatcher.port`, the `GradedRequest` decorator, the exported `RateLimitGuard`, and the two module files.
- `no-avatar-gateway-import`: avatar holds no gateway import and the rule has no seam at all, so every edge into gateway, seam or not, is a violation.

The narrowed set drops exactly one seam from ADR-0106's: the shared Fastify request primitive. Today the drop is preventive — auth's only file declaring `module 'fastify'` is the exported `UserAccessJwtGuard`, and gateway declares none — so the restricted rules and the general rule currently report the same edges. The value is the ratchet: when a future file declares the shared request primitive, the general rule exempts it on every edge while these two edges keep refusing it until someone widens this record.

The rules live in dependency-cruiser configuration, which `scripts/checks/architecture/check-architecture.mjs` runs as its second stage, so `bun run arch-check` fails on each of them. The spec in `scripts/checks/architecture/check-architecture.spec.ts` pins each rule's shape and its silence over the real tree, and its fixture cases prove the check fails on a synthetic violation of each edge.

- Status: Accepted (amends ADR-0106)
- Related issue: [#1733](https://github.com/AiHub-Ecosystem/aihub-be/issues/1733)
- Related: [ADR-0066](0066-cross-module-imports-are-checked-not-yet-forbidden.md), [#1576](https://github.com/AiHub-Ecosystem/aihub-be/issues/1576)
