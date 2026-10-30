# Test runner evaluation: Jest + SWC and Vitest

Status: prototype evaluation for [#1019](https://github.com/AiHub-Ecosystem/aihub-be/issues/1019); this is not an accepted toolchain change or a migration authorization.

## Scope

The prototype runs Vitest 5.0.5 alongside the current Jest 29 + `@swc/jest` lane. It keeps the application CommonJS and transforms TypeScript tests and source to ESM with the repository's existing SWC dependency, including legacy decorators and decorator metadata. It runs seven representative suites: Writing domain, application, repository and Fastify injection tests, architecture checks, a timer-fake suite, and a suite using Jest mock functions.

`pnpm test` and the existing coverage lanes still use Jest. The Vitest output goes to `coverage/runner-evaluation/vitest`; it does not overwrite `coverage/unit`.

Run the prototype with `pnpm test:vitest:spike`, repeat the performance comparison with `pnpm benchmark:test-runners -- --samples=3`, or compare coverage alone with `pnpm benchmark:test-runners -- --coverage-only`. The coverage comparison exits nonzero while the reports differ.

## Compatibility

The seven suites passed 98/98 tests on both runners. The prototype aliases runtime `jest` calls to Vitest's `vi`, and verifies `jest.fn`, mock implementations, modern fake timers, `advanceTimersByTimeAsync`, Nest decorator metadata, and Fastify injection.

The benchmark config uses a 20-second per-test timeout on both runners because the architecture suite synchronously starts `pnpm arch-check` for many fixtures. Vitest exceeded the default five-second timeout in two fixtures during a combined run; the architecture suite passed 39/39 when run alone. The repository's default Jest timeout and configs remain unchanged.

The sample does not exercise top-level `jest.mock` hoisting or `jest.isolateModulesAsync`, both of which occur elsewhere in the repository. Vitest's [Jest migration guide](https://vitest.dev/guide/migration/jest) documents API differences; a broader migration must explicitly handle those call sites and the `jest` type namespace.

## Measurements

Measured 2026-10-30 on Node 24.21.0, Windows x64, with 2.59 GB free memory at start. The repository's memory cap selected one worker for both runners. Each runner had one warm-up; three samples then ran sequentially in alternating order. RSS is the sampled sum of each runner's process tree working sets, polled at a nominal 400 ms interval. Worker startup is elapsed time from runner spawn until the first setup file executes.

| Runner     | Total median |       Range | Worker startup median | Peak RSS median | Peak RSS max |
| ---------- | -----------: | ----------: | --------------------: | --------------: | -----------: |
| Jest + SWC |       70.0 s | 67.2-76.9 s |                2.85 s |         939 MiB |    1,549 MiB |
| Vitest     |       76.6 s | 67.0-82.0 s |                1.00 s |         898 MiB |      924 MiB |

On this one-worker Windows run, Vitest's median total time was 9.5% slower. It reached the first test setup 1.85 seconds sooner and used 4.4% less median peak RSS. These results do not predict a two-worker CI run or a full-suite migration.

## Coverage and baseline

Vitest's V8 provider emits `coverage-final.json`, and the existing `istanbul-lib-coverage` reader accepts it. The report is not semantically equivalent to Jest's JSON for the same 16 Writing source files:

| Metric     |      Jest + SWC |       Vitest V8 |
| ---------- | --------------: | --------------: |
| Lines      | 218/542 (40.2%) | 144/464 (31.0%) |
| Statements | 232/586 (39.6%) | 149/494 (30.2%) |
| Branches   |  61/303 (20.1%) |  73/383 (19.1%) |
| Functions  |  44/114 (38.6%) |  44/114 (38.6%) |

The subset cannot establish full-suite equivalence. Also, `pnpm coverage:merged --check` is currently red in this workspace: it reads unit, database, and tenant-isolation reports last written on October 19, October 22, and October 16, respectively, and reports 80.1% lines / 63.4% branches against an 88.7% / 77.0% baseline. The spike leaves those lane reports and `test/coverage-baseline.json` untouched. Regenerate all three lanes before using the baseline gate to assess a runner change; do not lower or rewrite the baseline to accommodate this prototype.

Vitest's [coverage guide](https://vitest.dev/guide/coverage) describes its V8 and Istanbul providers. Both were sampled here; switching to V8 did not make the representative JSON totals match Jest.

## Recommendation

If minimizing peak memory matters more than total runtime, Vitest is the preferred migration candidate from this sample: its median peak RSS was 898 MiB versus Jest's 939 MiB, and its highest observed peak was 924 MiB versus Jest's 1,549 MiB. The trade-off was a 9.5% slower median total runtime. This is only three samples on a one-worker Windows run, so confirm the memory difference in the two-worker CI environment.

Keep Jest + SWC as the default until coverage equivalence and module-mock/isolation compatibility are resolved. The lower RSS makes Vitest worth pursuing under a memory-first priority, but the current coverage totals differ and top-level `jest.mock` hoisting and `jest.isolateModulesAsync` remain untested. #716 remains the separate decision owner for a database-lane runner change or Testcontainers.
