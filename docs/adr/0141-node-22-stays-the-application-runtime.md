# ADR-0141: Node.js 22 stays the application runtime; Bun is not adopted for it

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-01 in [#228](https://github.com/AiHub-Ecosystem/aihub-be/issues/228).
- Date: 2026-11-01
- Related: [ADR-0139](0139-bun-is-the-package-manager-node-stays-the-runtime.md), [ADR-0047](0047-nestjs-12-esm-only-framework.md), [ADR-0064](0064-ci-publishes-the-image-it-booted.md), [#228](https://github.com/AiHub-Ecosystem/aihub-be/issues/228), [#225](https://github.com/AiHub-Ecosystem/aihub-be/issues/225), [#226](https://github.com/AiHub-Ecosystem/aihub-be/issues/226), [#227](https://github.com/AiHub-Ecosystem/aihub-be/issues/227)

## Context

The suggestion to run the application on Bun returns every few months. [ADR-0139](0139-bun-is-the-package-manager-node-stays-the-runtime.md) made Bun the package manager and left the runtime as a separate decision. This is that decision, with the measurements behind it, so the next person reads a record instead of restarting the argument.

[#228](https://github.com/AiHub-Ecosystem/aihub-be/issues/228) was written when Bun 1.3.10 could not run the application: it lacked `process.loadEnvFile`, which the compiled entrypoint calls during module evaluation, and stopped at the tenth line of `dist/main.js`. **That is no longer true.** Bun 1.4.4 implements `process.loadEnvFile`, and the application boots under it. The decision below therefore rests on other grounds.

### Measurement

CI run 41264830728 on `ubuntu-latest` (Linux 7.0.0-azure, 4 vCPU, 16 GB), Node 22.23.4 against Bun 1.4.4, one build of `dist/` from `8d382b26`, a throwaway workflow on a branch that was never merged and has been deleted. The boot configuration is `scripts/ci/ci-boot-config.cjs`: every value is fake and nothing is contacted at boot, as in the Image boot job.

| Measure                                                   | Node 22.23.4 median (range) | Bun 1.4.4 median (range) |
| --------------------------------------------------------- | --------------------------- | ------------------------ |
| `require` of `dist/app.module.js`, 7 runs after a warm-up | 656 ms (647-668)            | 458 ms (446-483)         |
| process start to the first answer from `/health`, 5 runs  | 1102 ms (1098-1113)         | 882 ms (879-1093)        |
| RSS when `/health` first answers, 5 runs                  | 244 MiB (240-250)           | 205 MiB (202-208)        |

Bun's first boot (1093 ms) was cold; the other four were 879-885 ms. The boot runs `scripts/runtime/runtime-entrypoint.mjs` under each runtime. RSS is read when the server first answers, idle, so it says nothing about memory under load.

A single Windows developer machine under memory pressure, Node 24.21.0, gave the opposite order for the module load (Node about 560 ms, Bun about 1000 ms). That run is not comparable with the table and is not used here; it is recorded only so the disagreement is not hidden.

## Decision

Node.js 22 stays the runtime the application ships on: the `Dockerfile` entrypoint, the CI Image boot job and the production host keep running `node`. Bun stays the package manager and the unit-lane test runner ([ADR-0139](0139-bun-is-the-package-manager-node-stays-the-runtime.md)).

The grounds are, in order of weight:

1. **The measured gain is about 0.2 s on a boot phase.** Bun boots about 220 ms (20%) sooner and uses about 40 MiB (16%) less at idle. That is real, small and paid once per restart. It does not change what a restart costs a customer; the restart budget in [#225](https://github.com/AiHub-Ecosystem/aihub-be/issues/225) is the place that would show whether 0.2 s matters.
2. **A second runtime doubles what has to be proven.** The production image, the Image boot job, the N-minus-one release check, `ops/status.sh` and the blue-green cutover were all built and observed on Node. Moving the runtime means re-establishing each of them, not editing one line.
3. **What was shown is that it starts, not that it serves.** The boot check proves the server answers `/health`. It does not exercise request handling, the native `argon2` addon, the `undici` client paths the downstream calls use, OpenTelemetry, graceful shutdown or the database and Redis drivers under load. The unit lane already runs application code on Bun's runtime, but with the database, Redis and AI services faked.
4. **ADR-0047 is a Node arrangement.** The application stays CommonJS and relies on Node's `require()` of ESM-only packages ([ADR-0047](0047-nestjs-12-esm-only-framework.md)). That compatibility layer is Node's behaviour and has not been checked against Bun's.

## Revisit when all of these hold

- The database lane and the tenant-isolation lane pass with the application running on Bun's runtime.
- A CI job starts the image on Bun, sends a graded request through the Sandbox path against the mocked downstreams, and shuts down on `SIGTERM` within the existing budget.
- Memory and event-loop delay under the capacity benchmark (`.github/workflows/capacity-benchmark.yml`) are no worse on Bun than on Node, measured the same way.
- The restart budget from [#225](https://github.com/AiHub-Ecosystem/aihub-be/issues/225) is missed by an amount a runtime saving of this size would close.

Bun's reputation for speed is not a reason to reopen this. The question is only this application's measured boot path and the cost of supporting a second runtime.

## Relation to #225, #226 and #227

The boot-time and shutdown work is independent of this decision and is measured on Node. [#226](https://github.com/AiHub-Ecosystem/aihub-be/issues/226) (restart without a Windows-wide forced process-tree kill) and [#227](https://github.com/AiHub-Ecosystem/aihub-be/issues/227) (a shorter boot through a smaller startup require graph) do not wait for a runtime migration, and their gains add to anything a runtime change might later give, not replace it. A smaller require graph helps on Node whichever runtime is chosen.

## Consequences

- No change to the shipped image, the CI jobs or the production host.
- Running `bun dist/main.js` locally starts and answers `/health` with the boot configuration, but it is not a supported path, and a defect found only there is not a production defect.
- The numbers above are a snapshot of one build on one runner. They are not a benchmark to hold future changes to; the restart budget in #225 is.
