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
records. It reports 21 existing cross-module imports, and those imports are not
all mistakes. NestJS already provides a public seam through each module's
`exports:` array: `IdentityModule` exports `ApiKeyGuard` and
`UserIdentityGuard`, `AuthModule` exports `UserAccessJwtGuard`, and
`GatewayModule` exports `RateLimitGuard`, `QuotaGuard`, and
`ConcurrencyPermitInterceptor`. The graded-request decorator composes those
guards into the chain ADR-0057 declares to be a contract, because their order
decides whether a caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`. A
path-based rule cannot read a Nest `exports:` array, so it reports that seam
exactly as it reports reaching into a private file. Enabling it as an error
would reject a deliberate construction, so the rule reports until it can tell
the two apart.

## Considered options

Forbidding the 21 imports by rerouting them through application ports was
rejected: it would dismantle the graded-request chain that ADR-0057 makes
observable, and it would add ports for Nest guard objects that are not ports.
Moving the shared primitives into `src/common` was rejected for a second
reason found while implementing: `metering-evidence.ts` carries `MeteringModel`
and `MeteringUsage` from the metering port, so relocating it would make
`src/common` import a business module and violate the rule ADR-0061 added.
Listing shared primitives by hand in the config was rejected because a
maintained allowlist is the exemption issue #122 exists to forbid.

Detecting Nest `exports:` was considered and is the rule's eventual completion.
It requires reading decorator metadata, which dependency-cruiser does not
expose, so it belongs in `scripts/check-architecture.mjs` alongside the existing
custom checks rather than in this rule.

## Consequences

`pnpm arch-check` passes with 21 warnings that grow when a new cross-module
internal import appears, which is what makes the coupling visible while the
seam question is open. Every new import of this shape fails nothing, so nothing
is enforced yet; the rule earns its keep by naming the problem and by making the
21 edges measurable.

Nothing outside `src/modules` is covered. `src/cli` reaches three levels into
`identity/infrastructure` today and is a separate piece of work, because this
rule was scoped to what issue #122 describes. Spec files are excluded for the
same reason the test-helper rule excludes them: a test double is a tool of the
test, not a runtime dependency.
