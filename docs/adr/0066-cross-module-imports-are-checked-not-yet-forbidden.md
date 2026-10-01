# ADR-0066: Cross-module imports are checked, not yet forbidden

- Status: Accepted
- Related issue: #122
- Related: [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md), [ADR-0062](0062-speaking-sample-answer-public-copy.md)

The dependency-cruiser rules enforced layer direction but nothing stopped one
business module from reaching into another's internals. We added one rule that
does: a module may depend on another only through that module's public seam,
defined as its `<module>.module.ts` composition root, its
`application/**\/*.port.ts` contracts, a presentation primitive that declares
`module 'fastify'` and therefore extends the shared request type, a symbol its
module publishes through Nest `exports:`, or a Nest decorator. The rule reads
the module directory at load time so a file is shared only because it declares
that, never because a list happens to name it.

The rule is enabled at `warn`, not `error`, and that is the decision this ADR
records. Two of the imports it first reported were seams that only exist
because of how Nest composes, and both are now recognised.

The first is `exports:`. `IdentityModule` exports `ApiKeyGuard` and
`UserIdentityGuard`, `AuthModule` exports `UserAccessJwtGuard`, and
`GatewayModule` exports `RateLimitGuard`, `QuotaGuard`, and
`ConcurrencyPermitInterceptor`; the graded-request chain composes those into
the order ADR-0057 declares to be a contract, because the order decides whether
a caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`. Reading each module file's
`exports:` array out of its source, the same way the rule reads `declare
'module fastify'`, exempts the file declaring an exported symbol.

The second is decorators. `GradedRequest` and `RequireOperation` are consumed
by three modules each and appear in no `exports:` array, which first looked like
a missing export. It is not: both return `SetMetadata` or applied metadata
when called, so neither is a provider and neither can be resolved by the DI
container. Adding either to `exports:` would be wrong for the framework as well
as unnecessary, so the rule reads a file that declares a Nest decorator as a
seam of its own kind.

What remains is 11 imports of things no module publishes and no framework can:
`normalizeEmail` and the local-auth domain vocabulary from `auth`,
`normalizeMeteringUsage`, `extractDownstreamTelemetry`, and
`QuotaCounterOverwritePort` from `metering`, and `canonicalJson`, the
organization operation constants, and `resolveIdempotencyKey` from
`idempotency`. Six target files, four owning modules. Fixing them means either
publishing the symbol or moving the call behind a port, which changes
behaviour; the rule reports them so each one is visible and named rather than
assumed.

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

Reading `exports:` and decorator declarations is the cost of staying inside
dependency-cruiser, which the issue asked for. dependency-cruiser exposes no
decorator metadata, so both are read out of source. The exemption is coarser
than the truth it models: it covers the whole declaring file rather than the
single exported symbol, because a path-based rule cannot tell symbols apart.
That is acceptable only while the exemptions are derived from a declaration
rather than a maintained list, which is what makes them safe to leave
unenforced today.

## Consequences

`pnpm arch-check` passes with 11 warnings that grow when a new cross-module
internal import appears, which is what makes the coupling visible while the
seam question is open. Every new import of this shape fails nothing, so nothing
is enforced yet; the rule earns its keep by naming the problem and by making the
11 edges measurable.

Nothing outside `src/modules` is covered. `src/cli` reaches three levels into
`identity/infrastructure` today and is a separate piece of work, because this
rule was scoped to what issue #122 describes. Spec files are excluded for the
same reason the test-helper rule excludes them: a test double is a tool of the
test, not a runtime dependency.
