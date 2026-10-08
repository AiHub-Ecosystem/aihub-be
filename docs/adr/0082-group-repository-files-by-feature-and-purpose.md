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

Feature-first Identity grouping was chosen over feature subfolders inside each existing layer. Layer-first would have been a smaller move and would keep each layer's files together, but feature-first places one feature's application, infrastructure, and presentation files together, which directly serves the issue's navigation goal. The explicit layer names retain the dependency direction in the paths and in the architecture check.

## Consequences

- Moving a feature can change import and fixture paths across layers; all consumers and path-based tooling must be updated with the move.
- The Nest module remains one module. This decision adds no layer and changes no exported behavior, public route, schema, or migration.
- `pnpm arch-check` continues to check dependency direction. The entry-count limits are documented conventions, not an automated check.

## Recording note

The grouping choice was approved during issue grooming before implementation, but it was not recorded in an ADR or on the issue before the first file move. This ADR records the accepted choice for future work; it cannot retroactively satisfy #341's ordering criterion.

## Verification

On 2026-10-08, `pnpm verify:summary` passed with 201 suites and 2,017 tests, `pnpm test:db` passed with 25 suites and 370 tests, and `pnpm arch-check` reported no dependency violations. The moved-file Docker image built and its boot health check passed.
