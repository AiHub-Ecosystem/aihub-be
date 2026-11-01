# ADR-0142: A released contract defect is corrected through an accepted-change entry

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-01 in [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374).
- Date: 2026-11-01
- Amends: [ADR-0127](0127-public-api-uri-major-versioning.md)
- Related: [ADR-0134](0134-bounding-an-existing-collection-is-a-breaking-change-accepted-once-under-v1.md), [ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)

## Context

The first `/v2` release (contract 2.0.0, live on 2026-11-01) required
`data.meta.test_id`, `data.meta.part_result_id` and, on a question result,
`data.transcript.stats.speaking_seconds` and `word_count` to carry a value. The
AI Speaking service answers `null` for an identifier the request did not send and
for a recording without speech. The schemas came from captures that always sent
both identifiers and always held speech, so no spec caught it. A real call to the
deployed route with neither identifier answered `502 AI_SERVICE_CONTRACT_VIOLATION`,
and so would every such request: a valid request got no response at all.

The only correct contract allows `null` there. The release gate calls that a
breaking change to a supported major, because a response type was widened, and it
has no way to accept a change. It also refuses to drop `openapi/v2.json`, so the
2.0.0 contract could not be withdrawn.

## Decision

- **A narrow, explicit way past the gate.** `scripts/ci/api-compatibility/accepted-breaking-changes.json`
  lists accepted changes. Each entry names the major, the base and candidate
  contract versions, a decision record that exists in the repository, and the
  changes by the gate's exact text. An entry applies to that one version pair.
  A change not listed still fails. A listed change the gate no longer finds also
  fails, so the file cannot keep excusing something reverted or reworded. A
  missing or malformed entry fails.
- **Everything else still applies.** The contract version moves to the next minor
  and the changelog gets its entry, as for any contract change.
- **When it is used.** Only for a defect in a contract that has had no time to be
  adopted, with evidence in the decision record. It is not a way to ship a
  breaking change on purpose: that needs a new major.
- **This use.** 2.0.0 becomes 2.1.0, allowing `null` in the five places above.
  Evidence: the contract was live for less than a day; the first request that
  omitted the identifiers failed with the error above; no Organization is known
  to call `/v2` (the per-Organization adoption report of ADR-0127 was not run
  for this decision). A client that handled the old types keeps working, since a
  value is still returned whenever the request or the audio supplies one; a
  client that assumed a string for `test_id` now has to expect `null`.

- **Second use, the same day.** A Sandbox smoke of the 2.1.0 contract on the
  Part and Test routes answered 502 for a recording without speech:
  `data.meta.total_speaking_seconds` is `null` there and 2.1.0 still required a
  number. 2.1.0 becomes 2.2.0, allowing `null` for it on Part and Test results.
  The evidence is unchanged and still holds; the schemas were checked against
  real Part and Test aggregation responses for the recordings the smoke used,
  and no other mismatch was found. This is the second use for the same cause
  (schemas drawn from captures that all held speech), so a further widening is
  evidence that the schemas need review against more real responses before the
  next use, not a routine step.

## Consequences

The gate can be told to accept a change, which weakens it by exactly the entries
in that file; each is public, reviewed in the diff and tied to a record. The
Integration Guide and CHANGELOG state the new nullability. The two test
identifiers remain optional in the request, so nothing about requests changes.
