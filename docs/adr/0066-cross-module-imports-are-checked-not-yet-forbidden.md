# ADR-0066: Cross-module imports are checked, not yet forbidden

- Status: Accepted
- Related issue: #122
- Related: [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md), [ADR-0062](0062-speaking-sample-answer-public-copy.md)

The dependency-cruiser rules enforced layer direction but nothing stopped one
business module from reaching into another's internals. We added one rule that
does: a module may depend on another only through that module's public seam,
defined as its `<module>.module.ts` composition root, its
`application/**\/*.port.ts` contracts, or a presentation primitive that
declares `module 'fastify'` and therefore extends the shared request type. The
rule reads the module directory at load time so a file is shared only because it
declares that, never because a list happens to name it.

The rule is enabled at `warn`, not `error`, and that is the decision this ADR
records. NestJS publishes a symbol through each module's `exports:` array, and
that array is a real seam: `IdentityModule` exports `ApiKeyGuard` and
`UserIdentityGuard`, `AuthModule` exports `UserAccessJwtGuard`, and
`GatewayModule` exports `RateLimitGuard`, `QuotaGuard`, and
`ConcurrencyPermitInterceptor`. The graded-request decorator composes those
guards into the chain ADR-0057 declares to be a contract, because their order
decides whether a caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`. The rule
therefore reads each module's `exports:` array and exempts the file that
declares an exported symbol, which reduced the report from 21 cross-module
imports to 15.

The remaining 15 import things no module publishes: `normalizeEmail` and the
local-auth domain vocabulary from `auth`, `normalizeMeteringUsage`,
`extractDownstreamTelemetry`, and `QuotaCounterOverwritePort` from `metering`,
`canonicalJson` and the organization operation constants from `idempotency`,
`resolveIdempotencyKey` from `idempotency`, plus `GradedRequest` from `gateway`
and `RequireOperation` from `identity`, which are composed cross-module but
listed in no `exports:` array. Fixing those means either publishing the symbol
or moving the call behind a port, in eight files across four modules; the rule
reports them so each one is visible and named rather than assumed.

## Considered options

Forbidding the imports by rerouting them through application ports was
rejected: it would dismantle the graded-request chain that ADR-0057 makes
observable, and it would add ports for Nest guard objects that are not ports.
Moving the shared primitives into `src/common` was rejected for a second
reason found while implementing: `metering-evidence.ts` carries `MeteringModel`
and `MeteringUsage` from the metering port, so relocating it would make
`src/common` import a business module and violate the rule ADR-0061 added.
Listing shared primitives by hand in the config was rejected because a
maintained allowlist is the exemption issue #122 exists to forbid.

Detecting Nest `exports:` was considered and is the rule's eventual completion.
dependency-cruiser does not expose decorator metadata, so the rule reads the
`exports:` array out of each module file's source instead, the same way it reads
`declare 'module fastify'` to find shared primitives. That is a deliberate
trade: it keeps the exemption derived from the declaration rather than from a
maintained list, and it keeps the rule inside dependency-cruiser where the
issue asked for it, at the cost of matching by path so the exemption covers the
whole declaring file rather than the single exported symbol.

## Consequences

`pnpm arch-check` passes with 15 warnings that grow when a new cross-module
internal import appears, which is what makes the coupling visible while the
seam question is open. Every new import of this shape fails nothing, so nothing
is enforced yet; the rule earns its keep by naming the problem and by making the
15 edges measurable. Two of them are a defect this rule found rather than a
choice: `GradedRequest` and `RequireOperation` are composed by three modules
each, but neither is exported by the module that declares it.

Nothing outside `src/modules` is covered. `src/cli` reaches three levels into
`identity/infrastructure` today and is a separate piece of work, because this
rule was scoped to what issue #122 describes. Spec files are excluded for the
same reason the test-helper rule excludes them: a test double is a tool of the
test, not a runtime dependency.
