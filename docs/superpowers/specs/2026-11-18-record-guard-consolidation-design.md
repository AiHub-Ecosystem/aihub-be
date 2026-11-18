# Record guard consolidation design

## Context

Issue [#1755](https://github.com/AiHub-Ecosystem/aihub-be/issues/1755) asks the codebase to use `src/common/is-record.ts` as the canonical guard for non-null, non-array objects. `src/common/http/is-object.ts` duplicates a weaker check, and source and spec files contain handwritten variants.

The Identity domain layer cannot import `src/common` under its dependency rule. Its local guard is therefore a deliberate exception; changing that boundary is outside this issue.

## Options considered

1. **Use the shared guard everywhere the layer permits (recommended).** Replace duplicate utilities and handwritten checks with `isRecord`, while preserving explicit array branches where recursive logic accepts arrays. Keep the Identity domain guard local to respect its dependency boundary.
2. **Relax the domain dependency rule.** Let Identity domain import `src/common/is-record.ts` to satisfy the issue literally, at the cost of changing an established layer boundary for a small utility.
3. **Leave existing guards in place.** This avoids edits but leaves the duplication and does not complete the issue.

## Design

Replace callers of `isObject` and handwritten non-null object guards across `src/` with the shared `isRecord` helper, except for the Identity domain guard. Delete `src/common/http/is-object.ts`.

`isRecord` excludes arrays. Call sites that intentionally recurse through arrays keep an explicit `Array.isArray` branch before the record check. Property-reading guards use `isRecord` directly. Converting an array-accepting guard to `isRecord` narrows it to reject arrays; that is accepted here because no converted site read array contents, and each such site either keeps an explicit `Array.isArray` branch or returned the same value for an array. No accepted input shape, error mapping, or runtime policy changes.

Test-only helpers under `test/` keep their local guards; that directory is outside the `src/` scope this issue names.

## Verification seams

- Focused specs for edited production and test helpers.
- Confirm the duplicate `is-object` module is gone and remaining handwritten guards under `src/` are limited to the Identity domain exception.
- `test/` keeps its own local `isRecord` copies and one array-accepting variant; those are out of scope because the issue names `src/`, and moving them would put test-only helpers behind the `src/` dependency rule for no behaviour gain.
- Run `bun run check:changed`, `bun run verify`, and the issue-triage check.

## Scope

No dependency-rule changes, new helper abstractions, or behavior changes. One exception: `test/support/ai-speaking-fixtures.ts` was added because `check:duplication` counted the two identical Speaking fixture readers as a new clone at jscpd's 8-line minimum, and the gate blocks new clones; recording an exemption was the alternative and a shared reader was the smaller change. No production deployment or issue closure is included in this design.
