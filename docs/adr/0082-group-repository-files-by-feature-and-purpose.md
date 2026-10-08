# ADR-0082: Group repository files by feature and purpose

- Status: Accepted
- Date: 2026-10-08
- Related: [#341](https://github.com/AiHub-Ecosystem/aihub-be/issues/341)

Issue #341 addresses folders where files for many Identity features, script purposes, and test kinds were mixed together. The accepted grouping keeps those files easier to find while preserving the existing application layers, script behavior, routes, and module boundaries.

## Decision

- Group Identity code feature-first under `src/modules/identity/<feature>/{application,infrastructure,presentation}/`. Keep cross-cutting Identity code under `identity/shared/<layer>/`.
- Group scripts by purpose under `scripts/cli/`, `scripts/ops/`, `scripts/generate/`, `scripts/checks/`, `scripts/ci/`, and `scripts/runtime/`.
- Group CLI specs under `test/cli/` and integration specs under `test/integration/`. Keep shared setup and cross-cutting specs at the `test/` root.
- Keep each Identity feature-layer folder at 20 direct entries or fewer, and each of the `scripts/` and `test/` roots at 15 direct entries or fewer. Add a purpose or feature subfolder before exceeding those limits.

Feature-first Identity grouping was chosen over feature subfolders inside each existing layer. The issue prefers the smaller layer-first move unless the architecture check cannot express its rules; a temporary layer-first fixture confirmed that `pnpm arch-check` catches application-to-infrastructure, presentation-to-infrastructure, and infrastructure-to-presentation imports. During grooming, the repository owner explicitly approved feature-first because it places one feature's application, infrastructure, and presentation files together for navigation. This is an approved choice despite the checker supporting layer-first, not a limitation of the checker. The permanent architecture test verifies the same three rules in the feature-first layout.

## Consequences

- Moving a feature can change import and fixture paths across layers; all consumers and path-based tooling must be updated with the move.
- The Nest module remains one module. This decision adds no layer and changes no exported behavior, public route, schema, or migration.
- `pnpm arch-check` continues to check dependency direction. The entry-count limits are documented conventions, not an automated check.

## Recording note

The grouping choice was approved during issue grooming before implementation, but it was not recorded in an ADR or on the issue before the first file move. This ADR records the accepted choice for future work; it cannot retroactively satisfy #341's ordering criterion.

## Verification

On 2026-10-08, `pnpm verify:summary` passed with 201 suites and 2,020 tests, `pnpm test:db` passed with 25 suites and 370 tests, and `pnpm arch-check` reported no dependency violations. `pnpm arch-check` also rejected deliberately invalid imports under both layer-first and feature-first Identity paths. A fresh agent followed the scaffold guidance in a disposable worktree and placed a small Identity application helper and focused spec under `identity/scratch-labels/application/`; its focused spec, type-check, and architecture check passed. The moved-file Docker image built and its boot health check passed.
