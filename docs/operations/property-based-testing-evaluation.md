# Property-based testing evaluation

Status: evaluation for [#1697](https://github.com/AiHub-Ecosystem/aihub-be/issues/1697). This is a decision record, not an authorization to change the coverage gate or the default test lane.

## Scope

This evaluation answers whether generated-input testing should be a standing part of
AIHUB's test suite at the contract and pure-function boundaries. It is distinct from
the deterministic simulation evaluation in #1202 (multi-process async pipelines with
virtual time) and the Toxiproxy evaluation in #1203 (network faults). Here the unit of
work is a pure function or a parse boundary, with no real Postgres, Redis, JWKS, or AI
service involved.

The candidate invariants, taken from #1697, are:

- parsing a generated valid body yields a round-trippable result;
- parsing a generated invalid body yields a safe 4xx error, never a 5xx;
- canonical JSON serialization of a generated payload is stable under key order and
  idempotent under parse/serialize;
- metering evidence built from generated requests stays valid.

## What already exists

`fast-check@4.10.2` is a dev dependency. It is used only in specs. Four unit-lane
property specs state invariants in their test names:

- `src/common/serialization/canonical-json.property.spec.ts` — key-order independence
  at any depth, serialize/parse idempotence, and preservation of generated keys
  including `__proto__`, `constructor`, and `prototype`;
- `src/common/time/parse-utc-timestamp.property.spec.ts` — generated valid timestamps
  round-trip and out-of-format values are rejected;
- `src/modules/idempotency/application/idempotency-fingerprint.property.spec.ts` —
  semantically equal requests fingerprint identically;
- `src/modules/metering/application/quota/quota-period.property.spec.ts` — every
  generated instant lands in a period bounded by UTC month edges, the count rolls at
  the first millisecond of the next month, and month labels round-trip.

D2-specific fuzz coverage lives in `test/fuzz/`:

- `contracts.fuzz.spec.ts` discovers every exported `*RequestSchema` and
  `*QuerySchema` under `src/contracts/`, builds a valid candidate from the TypeBox
  schema, mutates string boundaries, and generates near-miss JSON values. It asserts
  that every accepted input produces a schema-valid parsed result and that every
  rejected input produces `AppError` with code `INVALID_REQUEST` and a public message
  that does not reflect the raw value.
- `speaking-multipart.fuzz.spec.ts` applies the same shape to the Speaking multipart
  boundary.
- `assert-with-reproducer.ts` runs `fast-check.assert` with a fixed seed and 96 runs.
  On failure it writes the seed, shrunk path, and counterexample to
  `test/fuzz/failed-cases/<name>.json`. A saved reproducer overrides the seed and path
  on subsequent runs, so a failure stays pinned until the file is deliberately removed.
- `seeds.json` records both seeds (`contracts`, `speakingMultipart`), per-spec budgets
  of 5,000 ms, a 10,000 ms lane budget, and a quarterly rotation schedule.

`bun run test -- test/fuzz/contracts.fuzz.spec.ts` was run on 2026-11-19: 1 pass, 0
fail, 4,228 expect calls, 1,131 ms. The specs are picked up by the standard
`bun test` lane through `scripts/cli/run-bun-test.mjs`; no separate nightly lane is
configured. The lane runs with `--isolate --smol --no-env-file` and a 30,000 ms
per-file timeout.

A shrunk counterexample was already used as a regression case: commit `016fff6ef`
added replay of saved fast-check failures. The original property tests landed in
`ada3bef58` under #329, a different issue that covered pure functions rather than a
decision to adopt the technique across contract schemas.

## Cost and flake

The contracts fuzz spec spends about 1.1 s of its 5,000 ms budget in the focused run
above. Four additional property specs and the speaking-multipart spec also run in the
unit lane. The seed and bounded run count make a passing run deterministic; a failing
run is pinned by a written reproducer. The residual flake risk is a generator change in
`fast-check` itself, which is contained by the lockfile, and budget pressure if many
more schemas are discovered. The combined fuzz budget is asserted against the lane
budget inside the spec.

The cost is bounded and paid per commit. There is no measured case for a nightly-only
lane: keeping properties in the unit lane is what makes a shrunk counterexample block
the merge that introduced it. Revisit if the measured fuzz portion approaches the
10,000 ms lane budget.

## Library choice

`fast-check` provides shrinking, seeded replay, and `assert` with a `path` option. The
current fuzz spec derives candidates from TypeBox schemas by walking `properties`,
`required`, `default`, `const`, `enum`, and the union keywords, then generating
near-misses with built-in arbitraries. It does not use a separate TypeBox arbitrary
package. That keeps a single generator library and ensures generated valid inputs are
checked with `Value.Check` against the same schema the API validates.

A dedicated TypeBox-arbitrary library would remove the hand-written schema walker,
but it would add a dependency whose generated values still need the same schema check
at the boundary. No evidence in this evaluation justifies that change.

## Decision

**Adopt, with the current scope already piloted.** Property-based and generated-input
tests stay in the standard unit lane at pure-function and parse boundaries. Keep
`fast-check` as the only generator library, keep fixed seeds and bounded runs, and
keep saved reproducers as the mechanism for pinning failures. Do not change any
coverage threshold, and do not add a nightly lane at current cost.

Boundaries:

- Stay at pure functions and request/response parse boundaries. Do not use generated
  inputs to drive real Postgres, Redis, JWKS, or AI services; the database lane in
  `test/db/` remains the place for engine-settled behavior.
- Keep generated valid inputs checked with `Value.Check` against the source schema.
  Never invent a response shape from a generator.
- Continue to respect the logging boundary: generated secrets and essay-shaped values
  are boundary inputs, not log payloads.

Revisit when the fuzz lane approaches its 10,000 ms budget, when a boundary cannot be
covered without a second generator library, or when a shrunk counterexample cannot be
pinned as a stable regression case.

## Issue status

The third acceptance criterion of #1697 is met by the specs and reproducer above. This
document supplies the first two: the candidate invariants, lane, and flake/cost
tradeoff, and an explicit adopt decision. The issue can close on this evidence.
