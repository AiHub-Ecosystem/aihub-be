# ADR-0115: TypeScript 7 gates CI; the TypeScript 6 API stays for tools

- Status: Accepted
- Date: 2026-10-21
- Amends: [ADR-0042](0042-tsgo-local-tsc-gates-ci.md) (supersedes its gate decision; the `moduleResolution: bundler` decision stands)
- Related: [#955](https://github.com/AiHub-Ecosystem/aihub-be/issues/955), [#796](https://github.com/AiHub-Ecosystem/aihub-be/issues/796), [research](../research/typescript-type-checker-options.md#measured-results-2026-10-21)

## Context

ADR-0042 kept `tsc` 5.9 as the CI gate because the TypeScript 7 compiler, `tsgo` from `@typescript/native-preview`, was a pre-release. That premise no longer holds:

- TypeScript 7.0 is a stable release (`typescript@7.0.2`).
- `@typescript/native-preview` stopped publishing at `7.0.0-dev.20260707.2`.
- On `ubuntu-latest`, `typescript@7.0.2` checked the repository in a median of 1.37 s, against 7.97 s for `tsc` 5.9.3. It reported the same diagnostics, at the same positions and with the same codes, on #796's seeded-error corpus.

TypeScript 7.0 ships no JavaScript API: the `typescript@7` package exports only its version. Two kinds of consumer still need the old API:

- dependency-cruiser, which runs inside `pnpm arch-check`, imports `typescript` and accepts only versions below 7. With TypeScript 7 installed under that name it stops reading TypeScript sources and reports 30 false violations.
- `scripts/checks/check-architecture.mjs` and `scripts/checks/check-import-style.ts` call `ts.createSourceFile` and related functions.

## Decision

Use the side-by-side layout that Microsoft documents for TypeScript 7.0:

- `@typescript/native` is an npm alias for `typescript@7.0.2`. Its `tsc` binary is the type-checker, so `pnpm type-check` (`tsc --noEmit`) runs TypeScript 7 and gates CI.
- `typescript` is an npm alias for `@typescript/typescript6@6.0.2`, which re-exports the TypeScript 6 API and ships only a `tsc6` binary. Every tool and script that imports `typescript` gets that API, and nothing competes for the `tsc` command.
- `@typescript/native-preview` and `type-check:tsgo` are removed. The gate now runs at the speed of the old local fast path, so the second command has no purpose.

The Nest CLI keeps its own TypeScript 6 dependency and is unaffected.

## Alternatives

- **Install `typescript@7.0.2` under its own name and point the scripts at `@typescript/typescript6`.** Rejected because dependency-cruiser resolves `typescript` itself and cannot be repointed without patching it.
- **Keep `tsc` 5.9 as the gate.** Rejected because it costs about 6.6 s on every CI type-check for a compiler that is now one major version behind.

## Consequences

- TypeScript 7 behaviour applies to the gate. Long type names in messages are shortened (`... 4 more ...`), and a check with errors exits 1 rather than 2. Package scripts only test for a non-zero exit, so the workflow is unchanged.
- The `typescript` import name no longer means "the compiler that gates CI". It means "the TypeScript 6 API". A new tool that needs the TypeScript 7 API waits for TypeScript 7.1, which is expected to publish one.
- Revisit this layout when dependency-cruiser supports TypeScript 7 or when TypeScript ships a stable 7.x API. Then `typescript` can return to the real compiler package.
