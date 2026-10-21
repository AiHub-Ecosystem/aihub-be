# TypeScript type-checker options for AIHUB BE

**Research date:** 2026-10-18  
**Scope:** Additional checker and performance options beyond `tsc`, `tsgo`, `tsrs` (#796), Oxlint type-check (#802), TypeScript incremental (#801), and Prisma generation (#800). The sections up to "Benchmark interpretation" are the original research. [Measured results](#measured-results-2026-10-21) records the AIHUB benchmark for #796 and #802 and replaces the original recommendation.

## Repository fit

AIHUB is one Node/NestJS application with a single `tsconfig.json` covering `src`, `test`, and `scripts`. In this checkout, `type-check` generates Prisma then runs `tsc --noEmit`; `type-check:tsgo` runs the same generator before `tsgo --noEmit`. The manifest requests TypeScript `^5.7.3`, while `pnpm-lock.yaml` resolves 5.9.3; it also pins `@typescript/native-preview` 7.0.0-dev.20260707.2. There are 793 hand-written `.ts` files under those three roots. See [package.json](../../package.json), [pnpm-lock.yaml](../../pnpm-lock.yaml), and [tsconfig.json](../../tsconfig.json).

The lockfile version matters: checker comparisons should use the versions actually resolved in the same checkout, and separately compare diagnostic differences caused by TypeScript 5.9 versus TypeScript 7.

## Candidates

| Option                    | What it does                                                                                                                                                                            | Evidence and fit for AIHUB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bun `bun check`**       | Full type checker; it is a port of `typescript-go`, built into Bun, and checks using multiple CPU cores. It is not a new checker lineage relative to AIHUB’s installed `tsgo`.          | Bun reports 3–6.4× lower wall time than `tsc` 7.0.2 and 2.2–4.9× lower memory on eight projects, measured on a 16-core Apple Silicon Mac. This is Bun’s own benchmark, not an AIHUB or `tsgo` comparison. It does not write `.tsbuildinfo`, has no check watch mode, and uses its bundled TypeScript 7 version, so every run checks the project and diagnostics may differ from AIHUB’s locked TypeScript 5.9.3 baseline. Worth including as a low-cost command/runtime comparison if benchmarking checker candidates; do not count it as an independent compiler family. [Bun v1.4.3 benchmark and checker details](https://bun.sh/blog/bun-v1.4.3), [Bun check docs](https://bun.sh/docs/runtime/check).                                                 |
| **`tsc-rs` / `ts-rust`**  | Separate, experimental Rust port of Microsoft’s native TypeScript Go compiler. It is distinct from OXC’s `tsrs`, despite the similar names, and belongs to the same TS-Go-based family. | The project reports a 2.10× geometric-mean speedup over TypeScript 7 across six open-source apps; `--fast` reports 2.90×. Measurements were five runs after one warm-up on 16-vCPU AMD EPYC Blacksmith runners, using `--noEmit --incremental false`; the compiler was `tsc-rs` 0.6.0 and TypeScript was 7.1.0-dev.20261008.1. The project says diagnostics matched that pinned TypeScript 7 baseline on those apps, but labels the port experimental and documents edge cases. This is the strongest genuinely additional checker to consider adding to #796’s comparison matrix, after `tsrs`; its results are not comparable directly to AIHUB’s TS 5.9.3 `tsc` run. [Project and benchmark methodology/results](https://github.com/pingdotgg/ts-rust). |
| **Deno `deno check`**     | Full type-check command backed by the TypeScript compiler; it plays the role of `tsc --noEmit`.                                                                                         | It offers no separately evidenced checker-speed advantage over TypeScript and introduces Deno as another tool/runtime into a Node application. Not worth an AIHUB-specific benchmark unless Deno is independently desired. [Deno TypeScript docs](https://docs.deno.com/runtime/fundamentals/typescript/).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **esbuild / SWC / `tsx`** | Fast transpilers or TypeScript runners, not full semantic type-checkers.                                                                                                                | esbuild explicitly says it does not type-check and recommends running `tsc --noEmit`; SWC says it only transpiles and recommends retaining `tsc`. AIHUB already uses SWC for builds and `tsx` for scripts, so switching the type-check command to a transpiler would leave type errors unchecked. Exclude as replacements. [esbuild TypeScript docs](https://esbuild.github.io/content-types/#typescript), [SWC migration guide](https://swc.rs/docs/migrating-from-tsc).                                                                                                                                                                                                                                                                                  |

`noCheck`, `--watch`, project references, and `.tsbuildinfo` are TypeScript compiler modes or project-structure choices, not separate checker libraries. They should stay under the existing incremental/project-layout evaluation (#801), especially since this repository currently has a single TypeScript project. TypeScript’s docs describe project references as a way to partition projects and speed up checks, but they require declaration boundaries and additional project configuration. [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references), [`noCheck`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-6.html#the-nocheck-option).

## Benchmark interpretation

The OXC `tsrs` project publishes broader and more detailed measurements than a typical vendor comparison: 17 projects on a 16-vCPU Linux AMD EPYC runner, with medians of 10 interleaved runs for `tsrs` and 3 for `tsgo`; its default uses up to 16 checker threads while `tsgo` defaults to 4. The published default table reports `vscode` at 0.82 s for `tsrs` and 11.10 s for `tsgo`, but `tsrs` targets TypeScript 7.1-dev while that `tsgo` baseline is 7.0.2. The report attributes diagnostic-count differences on eight of 17 projects to this compiler-version gap, and also says its benchmark CI is disabled. Treat the figures as a strong reason to run the project’s own comparison, not as expected AIHUB speedups. [OXC `tsrs` benchmark results](https://github.com/oxc-project/tsrs/blob/main/bench/RESULTS.md), [methodology](https://github.com/oxc-project/tsrs/blob/main/bench/README.md).

The `tsc-rs` report’s measured speedup is also promising, but it is an experimental port, benchmarked on a separate suite and with TypeScript 7.1-dev. Bun’s published figures use an Apple Silicon machine and compare with `tsc` 7.0.2, not the `tsgo` executable AIHUB already has. No cited benchmark includes AIHUB’s Prisma generation step. Keep the Prisma generation duration separate so checker performance is not confused with generated-client time.

## Measured results (2026-10-21)

This section answers #796 (checker alternatives) and #802 (Oxlint type-check mode). Both issues fixed their adoption bars before measuring; see the "Evaluation decisions" sections of those issues.

### Method

- **Runner:** GitHub-hosted `ubuntu-latest` (Ubuntu 24.04.5), 4 vCPU AMD EPYC 9V74, 16 GB memory, Node 22.23.3, pnpm 11.20.0, hyperfine 1.18.0. Run 39527784705, on commit `54389130` plus the temporary harness below. The harness was removed after the run; it is reproduced in full at the end of this section.
- **Timing:** `hyperfine` with 1 warmup and 10 runs per checker on the clean repository, with the Prisma client already generated. The tables report medians. Every checker ran with its default flags, so thread counts are each tool's own choice on 4 vCPU.
- **Memory and CPU:** one separate `/usr/bin/time -v` run per checker, which reports maximum resident set size and CPU share.
- **Prisma generation:** timed on its own. A cold run deletes `dist/generated/prisma` first (5 runs); a warm run hits the generator's unchanged-inputs stamp (10 runs). The full commands `pnpm type-check` and `pnpm type-check:tsgo` were timed from a cold generation (5 runs), which is the path a clean CI checkout takes.
- **Diagnostics:** the repository type-checks clean, so a matching zero would prove nothing. Each checker therefore also ran with the seeded-error corpus below copied into `src/`. Its output was compared with `tsc` 5.9.3 on file, line, column, and TS code.
- **Classes:** `identical` matches `tsc`. `version-attributable` is reproduced by a TypeScript release at the version the candidate tracks; the harness also ran `typescript@7.0.2`, `7.1.0-dev.20260929.1`, and `7.1.0-dev.20261008.1` for this. `checker-defect` differs only for that candidate.
- **Isolation:** candidates were installed into a directory outside the repository, pinned to exact versions. No dependency, script, or CI workflow on `main` changed.

| Seed | Construct                                                       | `tsc` 5.9.3 reports |
| ---- | --------------------------------------------------------------- | ------------------- |
| s01  | Missing export through the `@/` path alias                      | TS2305              |
| s02  | Missing field on a generated Prisma model via `@prisma-client/` | TS2339              |
| s03  | `exactOptionalPropertyTypes`                                    | TS2375              |
| s04  | `noUncheckedIndexedAccess`                                      | TS2322              |
| s05  | `verbatimModuleSyntax` value import of a type                   | TS1484              |
| s06  | Wrong argument type inside Nest `@Module()`                     | TS2322              |
| s07  | Method decorator `@Get()` applied to a class                    | TS1238, TS1270      |
| s08  | TypeBox `Static` mismatch                                       | TS2322              |
| s09  | `strictNullChecks`                                              | TS18048             |
| s10  | `noImplicitAny`                                                 | TS7006              |
| s11  | `noUnusedLocals`                                                | TS6133              |
| s12  | `noImplicitOverride`                                            | TS4114              |
| s13  | `Promise` type argument mismatch                                | TS2322              |
| s14  | `noImplicitReturns`                                             | TS7030              |

### Versions

| Checker                  | Version                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `tsc` (locked)           | 5.9.3                                                                                        |
| `tsgo`                   | `@typescript/native-preview` 7.0.0-dev.20260707.2, the last build that package published     |
| TypeScript 7 release     | `typescript@7.0.2`                                                                           |
| `tsrs`                   | 0.18.0-ts7.1.0-dev.20260929; reports 7.1.0-dev.20260930.4, microsoft/TypeScript@b85298b6a81f |
| `tsc-rs`                 | 0.7.0; reports 7.1.0-dev                                                                     |
| Bun `check`              | Bun 1.4.3                                                                                    |
| Oxlint type-check (#802) | `oxlint` 1.87.0 with `oxlint-tsgolint` 7.0.2004                                              |

`oxlint-tsgolint` records no TypeScript-Go commit. The only version string in its binary is 7.0.2. No diagnostic difference called for the extra arbiter run decided in #802, so none was made.

### Results

| Checker                                | Median (s) | Min–max (s) | vs `tsgo` | Peak RSS (MB) | CPU share | Seeded diagnostics | Clean repository |
| -------------------------------------- | ---------- | ----------- | --------- | ------------- | --------- | ------------------ | ---------------- |
| `tsc` 5.9.3                            | 7.970      | 7.902–8.087 | 0.17x     | 816           | 221%      | 15/15 (baseline)   | 0, exit 0        |
| `tsgo` 7.0.0-dev                       | 1.369      | 1.246–1.431 | 1.00x     | 788           | 376%      | 15/15, identical   | 0, exit 0        |
| `typescript@7.0.2`                     | 1.367      | 1.281–1.400 | 1.00x     | 790           | 375%      | 15/15, identical   | 0, exit 0        |
| `tsrs`                                 | 0.376      | 0.367–0.445 | 3.64x     | 390           | 328%      | 15/15, identical   | 0, exit 0        |
| `tsc-rs`                               | 0.556      | 0.541–0.583 | 2.46x     | 562           | 345%      | 15/15, identical   | 0, exit 0        |
| Bun `check`                            | 0.766      | 0.736–0.952 | 1.79x     | 338           | 346%      | 15/15, identical   | 0, exit 0        |
| `oxlint . --type-check` (#802)         | 2.310      | 2.269–2.501 | see below | 1127          | 352%      | 15/15, identical   | 0, exit 0        |
| `oxlint .` then `tsgo` (#802 baseline) | 3.323      | 3.162–3.444 | —         | 903           | 361%      | —                  | 0, exit 0        |

Megabytes are rounded from the reported kilobytes.

| Prisma generation and full commands         | Median (s) | Min–max (s) |
| ------------------------------------------- | ---------- | ----------- |
| Prisma generation, cold                     | 1.174      | 1.169–1.192 |
| Prisma generation, warm (stamp hit)         | 0.029      | 0.027–0.031 |
| `pnpm type-check` (cold generation + `tsc`) | 9.667      | 9.600–9.785 |
| `pnpm type-check:tsgo` (cold generation)    | 2.947      | 2.793–3.033 |

Prisma generation is about 12% of the CI `pnpm type-check` step; `tsc` 5.9.3 is the rest.

### Diagnostic differences

- **No candidate missed or added a diagnostic.** Every checker reported the same 15 diagnostics as `tsc` on the seeded corpus, at the same positions and with the same codes, and none on the clean repository. Every candidate is `identical`; no `checker-defect` was found.
- **Message text (`version-attributable`):** TypeScript 7 builds shorten long object types in messages. For example, `tsc` 5.9.3 prints the whole Prisma `ApiKey` shape in s02, while the TypeScript-Go family prints `... 4 more ...` and orders the members differently. `typescript@7.0.2` reproduces this, so it is a compiler-version change, not a candidate defect.
- **Exit status on errors (`version-attributable`):** `tsc` 5.9.3, `tsrs`, `tsc-rs`, and both TypeScript 7.1.0-dev builds exit 2. `tsgo`, `typescript@7.0.2`, Bun, and Oxlint exit 1. The split follows the TypeScript version each tool tracks. Package scripts only test for non-zero, so neither value changes the workflow.
- **Output format:** Bun prints its own two-line format, also available plainly with `--no-pretty`. On GitHub Actions, Oxlint switches to `::error` annotations, which carry the same file, position, and TS code.
- **#802 lint findings (appendix):** with `--type-check` on, the clean repository produced no new lint finding. On the seeded corpus Oxlint reported one lint finding besides the 15 type errors, `eslint(no-unused-vars)` on s11, which duplicates TS6133. It does not count toward the bar.

### Toolchain availability

| Candidate             | Linux CI                                     | Windows development                                                             |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `typescript@7.0.2`    | npm package, native binary                   | Native; the seeded smoke run matched Linux                                      |
| `tsrs`                | npm package with gnu and musl Linux binaries | **Unsupported natively:** no `win32-x64` binary is published. WSL only          |
| `tsc-rs`              | npm package, static Linux binary             | Native `win32-x64` binary; the seeded smoke run matched Linux                   |
| Bun `check`           | Bun runtime (npm `bun` or installer)         | Native; the seeded smoke run matched Linux. Adds Bun as a development toolchain |
| `oxlint --type-check` | Already a dependency                         | Native; the seeded smoke run matched Linux                                      |

Windows was smoke-tested only, as both issues decided: installation, exit status, and the seeded diagnostic set. No Windows timings are reported.

### Recommendation

Each bar was fixed before measuring: an optional checker must be at least 1.5x faster than `tsgo` and miss no diagnostic; Bun needs 2x; #802's combined step must be at least 1.5x faster than `oxlint .` followed by `tsgo`.

1. **#796: keep `tsc` as the CI gate in this issue, and add `tsc-rs` as an optional local checker (#956).** `tsc-rs` clears the bar at 2.46x with identical diagnostics, and it runs natively on Windows. `tsrs` clears it by more, at 3.64x, but it has no Windows binary, so it does not fit Windows development. Revisit `tsrs` if one is published. Bun's 1.79x is below its 2x bar, so Bun is not adopted. The absolute saving over `tsgo` is under one second per run.
2. **Larger finding: TypeScript 7.0 is now a stable release.** `typescript@7.0.2` matched `tsc` 5.9.3 diagnostic for diagnostic and ran 5.8x faster: 1.37 s against 7.97 s, about 6.6 s off every CI type-check. ADR-0042's reason for keeping `tsc` 5.9 as the gate was that `tsgo` was a pre-release, and that no longer holds. `@typescript/native-preview` has also stopped publishing. Moving the gate is a decision that amends ADR-0042, so it is tracked in #955 rather than made here. #955 also covers checking which tools still need the TypeScript 5 JavaScript API.
3. **#802: defer.** `oxlint . --type-check` took 2.310 s against 3.323 s for the baseline, a 1.44x speedup that is below the 1.5x bar. Even the slowest candidate run (2.501 s) against the fastest baseline run (3.162 s) gives only 1.26x. Its diagnostics were identical. Oxlint already used all four threads, so no tuning knob was left to try. Its peak memory was 1.13 GB against 0.90 GB. Keep `type-check:tsgo` as the local fast path, and re-measure once #955 settles the TypeScript 7 baseline.

### Benchmark harness

The harness ran from the temporary branch `bench/796-type-checkers`, which was then deleted. To repeat the run, put the 14 seeds from the table above in `bench/seeds/` and the script below in `bench/run.sh`, add the workflow, and push the branch.

<details>
<summary><code>bench/run.sh</code></summary>

````bash
#!/usr/bin/env bash
# Type-checker benchmark for #796 and #802. Lives only on a temporary branch;
# the method is recorded in docs/research/typescript-type-checker-options.md.
set -euo pipefail

OUT="${OUT:-artifacts/type-checker-benchmark}"
CANDIDATES="${CANDIDATES:-/tmp/type-checker-candidates}"
RUNS="${RUNS:-10}"
COLD_RUNS="${COLD_RUNS:-5}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

log() { printf '\n== %s\n' "$*"; }

# Keep the seeds out of the tree so the clean phase lints and checks nothing extra.
SEEDS=/tmp/type-checker-seeds
rm -rf "$SEEDS"
mv bench/seeds "$SEEDS"

log "Install candidates outside the repository"
mkdir -p "$CANDIDATES"
(
  cd "$CANDIDATES"
  npm init -y >/dev/null
  npm install --no-audit --no-fund \
    tsrs@0.18.0-ts7.1.0-dev.20260929 \
    tsc-rs@0.7.0 \
    bun@1.4.3 \
    ts702@npm:typescript@7.0.2 \
    ts710-0929@npm:typescript@7.1.0-dev.20260929.1 \
    ts710-1008@npm:typescript@7.1.0-dev.20261008.1
)
C="$CANDIDATES/node_modules"

# name|command; the order is the report order. Arbiter builds are the
# TypeScript releases each TypeScript-Go-based candidate tracks.
CHECKERS=(
  "tsc-5.9|node_modules/.bin/tsc --noEmit --pretty false"
  "tsgo-native-preview|node_modules/.bin/tsgo --noEmit --pretty false"
  "typescript-7.0.2|node $C/ts702/bin/tsc --noEmit --pretty false"
  "tsrs|$C/.bin/tsrs -p . --noEmit --pretty false"
  "tsc-rs|$C/.bin/tsc-rs -p tsconfig.json --noEmit --pretty false"
  "bun-check|$C/.bin/bun check --no-pretty"
  "oxlint-type-check|node_modules/.bin/oxlint . --type-check"
)
# #802 baseline: today's lint plus the local tsgo fast path.
LINT_BASELINE="node_modules/.bin/oxlint . && node_modules/.bin/tsgo --noEmit --pretty false"
ARBITERS=(
  "typescript-7.1.0-dev.20260929.1|node $C/ts710-0929/bin/tsc --noEmit --pretty false"
  "typescript-7.1.0-dev.20261008.1|node $C/ts710-1008/bin/tsc --noEmit --pretty false"
)

log "Record environment and versions"
{
  echo "commit: $(git rev-parse HEAD)"
  cat /etc/os-release
  lscpu
  echo "nproc: $(nproc)"
  free -b
  echo "node: $(node --version)"
  echo "pnpm: $(pnpm --version)"
  echo "hyperfine: $(hyperfine --version)"
  echo "tsc: $(node_modules/.bin/tsc --version)"
  echo "tsgo: $(node_modules/.bin/tsgo --version)"
  echo "oxlint: $(node_modules/.bin/oxlint --version)"
  echo "oxlint-tsgolint: $(node -p "require('./node_modules/oxlint-tsgolint/package.json').version")"
  echo "typescript-7.0.2: $(node "$C/ts702/bin/tsc" --version)"
  echo "tsrs: $("$C/.bin/tsrs" --version 2>&1 || true)"
  echo "tsc-rs: $("$C/.bin/tsc-rs" --version 2>&1 || true) (npm $(node -p "require('$C/tsc-rs/package.json').version"))"
  echo "bun: $("$C/.bin/bun" --version 2>&1 || true)"
} >"$OUT/environment.txt" 2>&1

log "Prisma generation: cold, warm, and timing breakdown"
rm -rf dist/generated/prisma
node scripts/generate/generate-prisma-client.mjs --timings >"$OUT/prisma-timings-cold.txt" 2>&1
node scripts/generate/generate-prisma-client.mjs --timings >"$OUT/prisma-timings-warm.txt" 2>&1
hyperfine --runs "$COLD_RUNS" --prepare 'rm -rf dist/generated/prisma' \
  -n prisma-generate-cold 'node scripts/generate/generate-prisma-client.mjs' \
  --export-json "$OUT/time-prisma-cold.json" --export-markdown "$OUT/time-prisma-cold.md"
hyperfine --warmup 1 --runs "$RUNS" \
  -n prisma-generate-warm 'node scripts/generate/generate-prisma-client.mjs' \
  --export-json "$OUT/time-prisma-warm.json" --export-markdown "$OUT/time-prisma-warm.md"

log "Full commands as CI runs them (cold generation)"
hyperfine --runs "$COLD_RUNS" --prepare 'rm -rf dist/generated/prisma' \
  -n 'pnpm type-check' 'pnpm type-check' \
  -n 'pnpm type-check:tsgo' 'pnpm type-check:tsgo' \
  --export-json "$OUT/time-full-command.json" --export-markdown "$OUT/time-full-command.md"
node scripts/generate/generate-prisma-client.mjs

run_diagnostics() {
  local phase="$1" entry name cmd status
  shift
  for entry in "$@"; do
    name="${entry%%|*}"
    cmd="${entry#*|}"
    set +e
    bash -c "$cmd" >"$OUT/diag-$phase-$name.txt" 2>&1
    status=$?
    set -e
    echo "$name $status" >>"$OUT/exit-$phase.txt"
  done
}

log "Diagnostics on the clean repository"
run_diagnostics clean "${CHECKERS[@]}" "${ARBITERS[@]}" "oxlint-baseline|$LINT_BASELINE"

log "Compiler-only timings on the clean repository"
args=()
for entry in "${CHECKERS[@]}" "oxlint-baseline|$LINT_BASELINE"; do
  args+=(-n "${entry%%|*}" "${entry#*|}")
done
hyperfine --warmup 1 --runs "$RUNS" --ignore-failure "${args[@]}" \
  --export-json "$OUT/time-checkers.json" --export-markdown "$OUT/time-checkers.md"

log "Peak memory and CPU share"
for entry in "${CHECKERS[@]}" "oxlint-baseline|$LINT_BASELINE"; do
  /usr/bin/time -v bash -c "${entry#*|}" >/dev/null 2>"$OUT/memory-${entry%%|*}.txt" || true
done

log "Diagnostics with the seeded-error corpus"
mkdir -p src/bench-seeds
cp "$SEEDS"/*.ts src/bench-seeds/
run_diagnostics seeded "${CHECKERS[@]}" "${ARBITERS[@]}"
rm -rf src/bench-seeds

log "Summary"
{
  echo "## Compiler-only (clean repository, generated client present)"
  cat "$OUT/time-checkers.md"
  echo
  echo "## Prisma generation"
  cat "$OUT/time-prisma-cold.md" "$OUT/time-prisma-warm.md"
  echo
  echo "## Full commands (cold generation)"
  cat "$OUT/time-full-command.md"
  echo
  echo "## Exit status"
  echo '```'
  echo "clean:"; cat "$OUT/exit-clean.txt"
  echo "seeded:"; cat "$OUT/exit-seeded.txt"
  echo '```'
  echo
  echo "## Peak memory (kB) and CPU share"
  echo '```'
  for f in "$OUT"/memory-*.txt; do
    printf '%s: %s, %s\n' "$(basename "$f" .txt)" \
      "$(grep -m1 'Maximum resident' "$f" | awk '{print $NF}')" \
      "$(grep -m1 'Percent of CPU' "$f" | awk '{print $NF}')"
  done
  echo '```'
} >"$OUT/summary.md"
cat "$OUT/summary.md"
````

</details>

<details>
<summary><code>.github/workflows/type-checker-benchmark.yml</code></summary>

```yaml
name: Type-checker benchmark

# Temporary: exists only on bench/796-type-checkers for #796 and #802.
on:
  push:
    branches: [bench/796-type-checkers]

permissions:
  contents: read

jobs:
  benchmark:
    name: Type-checker comparison
    runs-on: ubuntu-latest
    timeout-minutes: 90

    steps:
      - name: Check out repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Set up pnpm
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
        with:
          version: 11.20.0

      - name: Set up Node.js
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install measurement tools
        run: sudo apt-get update -q && sudo apt-get install -y -q hyperfine time

      - name: Run benchmark
        run: |
          bash bench/run.sh
          cat artifacts/type-checker-benchmark/summary.md >> "$GITHUB_STEP_SUMMARY"

      - name: Upload raw results
        if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: type-checker-benchmark-${{ github.run_id }}
          path: artifacts/type-checker-benchmark/
          if-no-files-found: error
          retention-days: 30
```

</details>

## Primary sources

- [Bun v1.4.3 release and `bun check` benchmark](https://bun.sh/blog/bun-v1.4.3)
- [Bun `check` behavior, cache and version limitations](https://bun.sh/docs/runtime/check)
- [`tsc-rs` / `ts-rust` project status and benchmark methodology](https://github.com/pingdotgg/ts-rust)
- [OXC `tsrs` benchmark methodology](https://github.com/oxc-project/tsrs/blob/main/bench/README.md) and [results](https://github.com/oxc-project/tsrs/blob/main/bench/RESULTS.md)
- [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references) and [TypeScript 5.6 `noCheck`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-6.html#the-nocheck-option)
- [Deno TypeScript support](https://docs.deno.com/runtime/fundamentals/typescript/)
- [esbuild TypeScript handling](https://esbuild.github.io/content-types/#typescript) and [SWC migration from `tsc`](https://swc.rs/docs/migrating-from-tsc)
