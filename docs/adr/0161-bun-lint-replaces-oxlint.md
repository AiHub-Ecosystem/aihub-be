# ADR-0161: Bun lint replaces Oxlint; Biome keeps formatting

- Status: Accepted
- Date: 2026-11-11
- Amends: [ADR-0037](0037-oxlint-lints-biome-formats.md) (linter), [ADR-0139](0139-bun-is-the-package-manager-node-stays-the-runtime.md) (Bun version pin)
- Related: [#1815](https://github.com/AiHub-Ecosystem/aihub-be/issues/1815)

## Context

Issue #1815 measured Bun's built-in linter against the existing Oxlint and Biome checks. On the same Windows host, after a clean dist and a successful warm-up, three-run medians were 1,106 ms for Bun lint, 25,009 ms for configured Oxlint, and 643 ms for Biome check. The Bun linter read the existing .oxlintrc.json and enforced the configured type-aware promise, unsafe, import, and Jest rules in the acceptance fixture.

The linter is available in the exact npm release 1.4.4-canary.20261109.1; stable 1.4.4 does not provide the built-in lint command. The formatters produced byte-identical output for only 40 of 1,563 compared files, so replacing Biome would require broad formatting churn. Biome also owns organizeImports.

## Decision

Pin Bun 1.4.4-canary.20261109.1 in package.json, CI, and the Docker build so local development and CI use the same reproducible executable. The lint script runs bun lint with the existing .oxlintrc.json, type-aware rules, and a zero-warning limit, followed by biome check. Remove Oxlint and oxlint-tsgolint dependencies; Bun provides the type-aware checks.

Use Bun lint in the staged-file fixer and type-aware staged checks. Keep the pre-commit hook's existing check:staged entry point and its related Jest checks. Keep Biome as formatter and import organizer.

## Consequences

The same pinned canary version is required for every Bun package-manager, test-runner, and Docker build lane. Updating Bun requires an explicit version bump and rerunning the linter rule-parity checks; the canary channel is not a moving CI dependency.

The repository relies on Bun's compatibility with .oxlintrc.json. The original Oxlint configuration and rule history remain useful as the source of that configuration, while ADR-0037's linter choice is superseded.
