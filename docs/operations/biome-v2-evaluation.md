# Biome 2 formatter evaluation

Baseline: `main` at `9df4dc409` (2026-11-12), before this evaluation. Prettier 3.9.10's existing `--check` command passed on the tracked Markdown and YAML files.

Biome 2.6.7 migrated the Biome 1.9.4 configuration and formatted 1,895 discovered files. With the default embedded-code formatting, 26 files changed: 19 Markdown, five TypeScript, one MJS and `biome.json`. Setting `markdown.formatter.formatEmbeds` to `false` reduced the formatter diff to 18 files: 11 Markdown, five TypeScript, one MJS and `biome.json`. No YAML file changed.

The eight avoided Markdown changes came from formatting code fences with Biome's JavaScript options. The remaining Markdown changes are YAML front-matter spacing in ten `.claude/rules/*.md` files and blank-line normalization around lists and code fences in `docs/operations/image-vulnerability-scanning.md`. The migrated config also moves `organizeImports` under `assist.actions.source` and converts `files.ignore` to ordered `files.includes`; it explicitly re-includes `test/fixtures/ai-speaking/README.md` to retain the previous Prettier coverage.

## Decision: defer Biome 2

Formatter churn alone is manageable, but the migrated `biome check .` reports 419 import-organization diagnostics with Biome 2.6.7's default organizer. The compatibility groups documented in the [Biome v2 upgrade guide](https://biomejs.dev/guides/upgrade-to-biome-v2/) did not preserve this repository's ordering and reported 896 diagnostics. The guide states that exact Biome 1 import-sorting parity is unavailable.

ADR-0161 says to keep Biome as the import organizer. Since #1815, Bun lint has replaced Oxlint and Biome lint remains disabled; keep Bun lint and do not replace it with `biome check` alone. Disabling the organizer or accepting hundreds of import changes is outside this formatter-only issue, so keep Biome 1.9.4 and Prettier for now. Reopen the migration when Biome supports a v1-compatible organizer mode, or when the repository explicitly schedules and accepts the import-order migration.

Prettier removal also requires migrating two live callers: `scripts/generate/generate-data-dictionary.ts` and `scripts/ops/postgres-query-plan-baseline/plans.ts`. The `Cache prettier` step was already absent from `.github/workflows/ci.yml` on the baseline; CI still runs `bun run format:check`. The existing cache test asserted the missing workflow step and failed, so its assertion now checks the gate CI actually runs.
