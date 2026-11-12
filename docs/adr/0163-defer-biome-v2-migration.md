# ADR-0163: Defer the Biome 2 formatter migration

- Status: Accepted
- Date: 2026-11-13
- Related: [ADR-0037](0037-oxlint-lints-biome-formats.md), [ADR-0161](0161-bun-lint-replaces-oxlint.md), [#1813](https://github.com/AiHub-Ecosystem/aihub-be/issues/1813)

## Context

Issue #1813 evaluated upgrading Biome 1.9.4 and removing Prettier. The [formatter diff](../operations/biome-v2-evaluation.md) is bounded to 18 files when embedded code formatting is disabled, and the current Prettier check passes. However, `biome check .` with Biome 2.6.7 reports 419 import-organization diagnostics. The custom groups suggested by the [Biome v2 upgrade guide](https://biomejs.dev/guides/upgrade-to-biome-v2/) report 896; the guide says exact v1 sorting parity is unavailable.

ADR-0161 explicitly keeps Biome as the import organizer. Since #1815, Bun lint has replaced Oxlint and Biome lint remains disabled; this evaluation preserves that split. Disabling the organizer or accepting a broad import-order rewrite would change ADR-0161 beyond the formatter evaluation. Prettier also has two live CLI/API callers that must be migrated before its dependency can be removed.

## Decision

Defer the Biome 2 migration. Keep Biome 1.9.4 and Prettier, and keep the current `format`, `format:check`, and staged-file behavior. Continue using Bun lint as recorded in ADR-0161.

## Reopen when

Re-evaluate when Biome provides a v1-compatible organizer mode, or when the repository explicitly schedules and accepts the import-order migration and the two Prettier caller changes.

## Consequences

This preserves the current import organizer and avoids unrelated source churn. Prettier remains required by the format gate and both generator/report callers. CI already has no persistent Prettier cache step; its format-check step remains.
