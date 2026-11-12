# Nightly mutation testing

The nightly StrykerJS run checks whether tests detect changes in six pure-logic
security and correctness areas: API keys, idempotency fingerprints, canonical
JSON, error codes and their HTTP status registry, opaque tokens, and the email
envelope cipher. The error-code and error-registry files are separate mutation
targets for one issue-listed area. Stryker currently generates no mutants in
`error-code.ts` because it contains constants and types only.

The workflow runs at 04:23 UTC and supports manual dispatch. It does not run on
pull requests. Stryker writes JSON and HTML reports to `temp/mutation-testing/`,
which the workflow uploads as a 90-day artifact even when the mutation step
fails. The job has a 20-minute timeout.

Before invoking the TypeScript checker, the job generates the Prisma and
Kysely types consumed by the repository-wide `tsconfig.json`.

Jest related-test selection runs tests associated with each mutated file.
`coverageAnalysis` is disabled because the current Jest integration does not
provide Stryker's per-test coverage map; this selection keeps the full run within
the job budget. The post-triage run took 8 minutes.

## Triaged baseline — 2026-11-11

The initial report generated 231 mutants. Tests killed 74 and 59 survived; the
TypeScript checker rejected 98 mutants at compile time. The added API-key and
cipher tests killed 55 of those initial survivors. In the post-triage report,
the checker again rejected 98 mutants, which are excluded from the mutation
score denominator. Tests killed 129 of the 133 executable mutants and 4
survived, for an overall score of 96.99%. The run selected 142 related tests
and had no timeouts.

| Issue-listed area                           | Mutation target                      | Killed | Survived |   Score |
| ------------------------------------------- | ------------------------------------ | -----: | -------: | ------: |
| API key generation and parsing              | `api-key.ts`                         |     31 |        0 | 100.00% |
| Idempotency fingerprinting                  | `idempotency-fingerprint.ts`         |      2 |        0 | 100.00% |
| Canonical JSON serialization                | `canonical-json.ts`                  |     31 |        3 |  91.18% |
| Error code registry and HTTP status mapping | `error-code.ts`, `error-registry.ts` |      5 |        0 | 100.00% |
| Opaque token issuer                         | `opaque-token-issuer.ts`             |      6 |        0 | 100.00% |
| Email payload cipher envelope               | `envelope-cipher.ts`                 |     54 |        1 |  98.18% |

The nightly run fails if the overall score falls below 95%. The floor is below
the triaged baseline while still detecting a meaningful regression.

## Equivalent mutants

These four survivors were reviewed against the implementation and recorded as
equivalent:

- `canonical-json.ts:48–49`, mutants 63, 65, and 66: `canonicalize` throws for
  `undefined`, functions, and symbols; every value it returns is JSON
  serializable, so this `JSON.stringify(...) === undefined` branch is
  unreachable.
- `envelope-cipher.ts:154`, mutant 161: the key ID regex `{1,64}` already
  rejects an empty string, so the explicit `length === 0` check is redundant.
