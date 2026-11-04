# ADR-0148: Use CodeQL as the SAST engine

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-04 in [#330](https://github.com/AiHub-Ecosystem/aihub-be/issues/330).
- Date: 2026-11-04
- Related: [#330](https://github.com/AiHub-Ecosystem/aihub-be/issues/330), [ADR-0088](0088-prisma-for-control-plane-persistence.md), [ADR-0110](0110-source-file-length-and-class-responsibility-ceiling.md)

## Context

CI runs lint, type-check, architecture and import checks, and a dependency
audit. None of them follows a value from untrusted input to a dangerous sink.
Issue #330 asks for a static analysis job on pull requests, pushes to `main`
and a weekly schedule, with custom rules for raw SQL, the logger, Redis `eval`
script text, S3 object keys, regular-expression backtracking and `process.env`
reads.

The repository is public, so CodeQL needs no licence. The choice is CodeQL or
Semgrep.

## Decision

Use CodeQL (`security-extended` plus the queries in `.github/codeql/`) in
`.github/workflows/sast.yml`.

- **Data flow.** CodeQL's taint tracking models Fastify and Express request
  input, so "request value reaches `$queryRawUnsafe`" is a flow query, not a
  text pattern. The Semgrep OSS engine tracks flow inside one function only.
- **Reporting.** SARIF uploads to GitHub code scanning under the category
  `/language:javascript-typescript`, with alert history and per-alert dismissal.
- **Tests.** Each custom query has a fixture directory under
  `.github/codeql/tests/` with a positive and a negative case, run with
  `codeql test run`.
- **Cost accepted.** Queries are written in QL, which fewer contributors know
  than Semgrep rules. The CodeQL job also needs a database build, about 125 s
  locally.

Re-evaluate the choice if the repository becomes private, since code scanning
then needs GitHub Advanced Security.

## Gate

The scan runs with `upload: never`, uploads the SARIF in a separate step, and
then `scripts/checks/codeql-gate.ts` decides the job result. A finding passes
when the scanner marks it suppressed or `.github/codeql/triage.json` holds an
entry for that one alert with a written reason. Any other finding fails the
job. A SARIF file with no runs also fails, so a scan that did not happen
cannot pass.

A triage entry names an alert by rule, path and `fingerprint`, the scanner's
`primaryLocationLineHash`. A second alert of the same rule in the same file is
new and fails. So does the same alert after its source line changes, because
the hash changes; the author then re-triages it. The failing gate prints the
fingerprint to copy into the entry.

A separate `fixtures` job in the same workflow runs `codeql test run` over
`.github/codeql/tests`, so a query that stops matching its positive fixture, or
starts matching its negative one, fails CI.

Tooling paths (`scripts/`, `ops/`, `prisma/`, root `*.config.*`) are outside
the `process.env` query, because they have no configuration module. `src/` is
inside it except `src/config` and `src/cli`. `test/`, `*.spec.ts`, `dist`,
`coverage` and the query fixtures are not scanned.

## Structural guard

`bun run arch-check` rejects a `$queryRawUnsafe` or `$executeRawUnsafe` call
whose first argument is not a string literal, a template literal made of
static parts, or a same-file `const` that holds one. It also rejects a use of
either method that is not a direct call (destructured, `.bind`, `.call`).

A `WHERE` or `ORDER BY` fragment built from a closed set is listed once, in
`SQL_FRAGMENT_ALLOWLIST` in `scripts/checks/check-architecture.mjs`. A template
literal may interpolate a call to a listed builder (today `billableRequestSql`)
when it is imported from the listed module and its arguments are literals.
Adding a builder means adding it to that list after review; a request value
cannot reach a fragment, because arguments must be literals.

A deliberately dynamic call, such as a shared SQL wrapper, keeps only with an
`arch-check: <reason>` comment on the previous, same or next line. This layer
proves the shape of the call. The CodeQL query proves where its values came
from.

## Runtime

Measured on 2026-11-04 on a developer machine, full repository, 791 files:
database create 124 s, query analysis 97 s, 221 s in total. The CI target is
350 s for the scan. The slowest job in the latest `ci.yml` run on `main` is
Unit tests at 343 s; SAST runs as a separate workflow in parallel, so it
lengthens the critical path only if it exceeds that job.

First CI run (2026-11-04, run 41809681993 on `004638b1`): the job took 327 s
end to end (init 17 s, analyze 288 s, install and upload 15 s). That is under
the 350 s target and under the 343 s Unit tests job. The run also confirmed
that the action resolves the local `./.github/codeql` pack and writes
`codeql-results/javascript.sarif`, and the gate passed with the committed
`triage.json`.

## Consequences

- A new finding blocks merge once branch protection requires the `CodeQL`
  check; that requirement is tracked in #1385.
- Every triage entry is a reviewed claim about one alert in
  `.github/codeql/triage.json`. A stale entry (no matching finding) prints a
  warning and does not fail.
- Adding a sink means adding a query and a fixture pair, not editing the gate.
