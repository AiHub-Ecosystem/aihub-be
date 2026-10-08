# ADR-0067: Intra-repo imports resolve through an alias, and the alias is enforced

Status: Accepted
Related issue: #213
Related: [ADR-0037](0037-oxlint-lints-biome-formats.md), [ADR-0042](0042-tsgo-local-tsc-gates-ci.md), [ADR-0066](0066-cross-module-imports-are-checked-not-yet-forbidden.md)

Every import of shared code from `src/modules/**` reaches up with a parent-relative
specifier, so the thing being named is a path relative to wherever the reader's
cursor happens to be: `../../../common/errors/app-error`. AIHUB resolves those
through one alias, `@/*` to `src/*`, and a repository-owned check makes the alias
mandatory rather than merely available. The mapping is scoped to `src/*` so `@/`
can never resolve into `test/`, `scripts/`, or `dist/`.

This is not a correctness fix and must not be sold as one. A moved file with a
stale relative path already fails `tsc --noEmit`, loudly, in `verify` and in CI.
What the alias buys is that the import names the target rather than the reader's
distance from it, and what enforcement buys is that the change does not decay into
half-reverted churn across the next few hundred files. It is also not a boundary
change: `src/common` stays cross-cutting, a module still reaches another only
through its public seam, `domain` still has no framework imports, and every
dependency-cruiser rule keeps its current severity. The alias is a naming
convenience over the same files.

The rule is deliberately narrower than "no `../`". A parent-relative specifier
whose resolved target lies under `src/` is an error; a sibling `./x` is fine, and
so is a parent-relative import resolving outside `src/`, which is five call sites:
`test/db/tenant-isolation/*.spec.ts` reaching the local `test/db/database.ts`,
`scripts/checks/check-architecture.spec.ts` reaching `.dependency-cruiser.cjs`, and
`test/cli/cli-loader.spec.ts` reaching `load-cli-runner.cjs` through a `createRequire`
handle named `requireScript`. Scoping by resolved target rather than by spelling
means the rule needs no allowlist and nothing to maintain, which is the same reason
ADR-0066 rejected a hand-maintained exemption list. A blanket ban on `../` would
have needed exactly that list. Siblings stay relative, and the alias is not the
shorter spelling for every hop — `../domain/metering` becomes
`@/modules/identity/domain/metering` — which is the right trade anyway, because the
deep reaches-up cases are the bulk of the corpus and a module-local hop is already
unambiguous. "Parent-relative" is decided per segment rather than by leading
`../`, because `./../../../common/errors/app-error` and a bare `..` reach the same
place.

The check reads import positions only: static `import` and `export … from`,
`require(...)`, and dynamic `import(...)`. It never reads a bare string literal and
never reads a comment, and that boundary is load-bearing rather than pedantic.
Parent-relative paths that are not import positions are common in this repository,
and one of them must not move: `src/openapi/openapi.controller.ts` resolves
`../../package.json` against the _compiled_ `dist/openapi/`, so rewriting it would
break the build it is meant to describe. The comment above it quotes the same path
in prose, so a text-matching rule would flag a line that is correct as written. The
same discipline governs the codemod: it rewrites specifier positions and nothing
else, so these paths survive by construction instead of by exemption.

Enforcement lives in a `scripts/` check rather than in the linter, and the reason is
scope rather than availability: oxlint 1.83.0 does ship
`import/no-relative-parent-imports`, but it decides on spelling, so it would report
all five legal call sites above and would have to be suppressed or narrowed. ADR-0037
also fixes oxlint as the linter and Biome as the formatter, and adding an import
plugin's rule set is a change to that decision. `scripts/checks/check-architecture.mjs`
already gates this repository by reading source for forbidden literals, so a
repository script is the established shape here rather than a new mechanism. The
source check reads the syntax tree through the TypeScript compiler rather than
matching text, which is what makes the comment and the `join(__dirname, '../..')`
cases above decidable rather than a list of exceptions; the output check is a text
match over emitted JavaScript, where the question is only whether the string `@/`
appears in a specifier position at all. It is written in TypeScript and run with
`tsx` like the other `scripts/**/*.ts` entry points, so its own spec imports it
directly instead of needing hand-written types for a `.cjs` or `.mjs` neighbour. It
stays in `scripts/**`, which the `infrastructure` role owns, and it is deliberately
not folded into `scripts/checks/check-architecture.mjs`, which the `testing` role owns:
this is an infrastructure concern wearing a testing file's location.

One limitation is recorded rather than closed. The check recognises `require` and
dynamic `import` by their syntax, so a specifier passed to a require-alike helper
built with `createRequire` is invisible to it. There is exactly one such call site
today and it resolves outside `src/`, so it is legal either way; a future one
reaching into `src/` would need the helper named rather than the syntax found.

Two consequences are worth recording because neither is visible in the code.
dependency-cruiser does not read `paths` unless `options.tsConfig.fileName` is set,
and it does not default to it, so that option is required here rather than
optional — and because `not-to-unresolvable` is `severity: 'error'` and
`arch-check` exits with dependency-cruiser's status, a misconfigured alias fails
loudly rather than silently. The same option switches on TypeScript config
extraction for the whole cruise, changing resolution for `no-circular` and for
every path-based rule, so the `pnpm arch-check` output before and after belongs in
the pull request; ADR-0066's warning count is a pinned assertion in
`scripts/checks/check-architecture.spec.ts` and must not move without being reported.
And `pnpm verify` is no longer what CI runs — the lanes were split per #108 — so a
check added only to `verify` is a local suggestion that no lane ever executes. The
check is added to `.github/workflows/ci.yml` explicitly for that reason. The same
file shows `build` and `arch-check` in separate jobs, so the assertion that no
`@/…` specifier survives into `dist/` has to run as its own step after the build
job rather than be skipped when `dist/` is absent; a silently skipped check is worse
than no check, because it reads as a pass.

Making the alias available without enforcing it was rejected: the codemod would be
partly undone by the next few hundred files while every later change to those files
carries a wider merge-conflict surface for nothing. A Node-native `#src/*` subpath
import map in `package.json` was rejected for the opposite reason — it resolves at
runtime, so the runtime image, all three Jest configurations, and dependency-cruiser
would each need to support it, while `paths` is resolved at build time in the one
place that already owns transforms. ADR-0042 is unchanged: `tsc` remains the CI
gate, and `tsgo` was exercised locally to confirm the alias resolves there too
rather than being added as a new gate.

No glossary term is introduced. `@/`, alias, and specifier are toolchain language,
not structural language of the module tree; `GLOSSARY.md` scopes itself to the
module tree's structure and `CONTEXT.md` holds business vocabulary, and the
relationship this decision has to seam-ness belongs here rather than there. This
rule is a second axis beside ADR-0066, not an extension of it: ADR-0066 asks which
file one module may import from another, this asks what shape any intra-repo
specifier must take. Neither subsumes the other and neither changes the other's
severity.

## Outcome

The check reported **970** imports to rewrite, which is the only corpus figure worth
quoting: the counts in the issue as first written did not reproduce, because
counting per line misses an import whose `from` clause sits on its own line. After
the rewrite the check reports zero, and the five legal parent-relative call sites
above are all that remain of the shape.

`arch-check` reports 14 warnings, 0 errors, 456 modules and 1699 dependencies both
before and after, and the pinned assertions in `scripts/checks/check-architecture.spec.ts`
hold unchanged. That is the evidence this decision did not move a boundary.

`tsconfig.json` carries `paths` alone, with `"./src/*"` as the target and no
`baseUrl`: `baseUrl` has been removed in the TypeScript 7 preview that
`oxlint-tsgolint` type-checks against, and it rejects it outright. `moduleResolution`
is already `bundler`, so the mapping resolves without one. `baseUrl` still appears
in `.swcrc`, where SWC requires it. Alias resolution was confirmed in each resolver
that had to be checked by hand rather than assumed: `tsc`, `tsgo`, oxlint's
type-aware pass, all three Jest configurations through `@swc/jest`, `knip`,
dependency-cruiser, and the SWC build. The alias-resolution assertion runs in the
shared Jest configuration only — the database and tenant-isolation configurations
match `test/db/**` and would not pick it up — but the rewritten `test/db/**` files
exercise the alias in those lanes on their own. The build emits 323 relative
`require` calls in place of the alias and no `@/…` specifier survives into `dist/`,
and the built application boots until it asks for a runtime secret file, which is
where an unconfigured workstation stops.

This landed as one change rather than the two-stage split it was specified as. The
split existed to keep the failure diagnostic if resolution were broken in one
resolver, and that reasoning holds, but a whole-tree mechanical rewrite with a gate
that fails on the first violation is reviewable without it. The check is the
completion criterion; nothing about the delivered result depended on the staging.
