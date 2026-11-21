# ADR-0180: Publish Speaking priority errors in `/v2`

- Status: Accepted
- Date: 2026-11-21
- Amends: [ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md) decision 3
- Related: [ADR-0177](0177-sanitize-and-bound-ai-service-grading-responses.md)

## Decision

AIHUB publishes the provider's `data.error_priority` on every public Speaking
v2 question, Part, and Test result. The field is an ordered list of at most
three entries with `rank` (1–3), `group`, `code`, `name_en`, `name_vi`, and
`reason_vi`. Group names and codes remain open strings. AIHUB preserves list
order and text after the existing control-character cleanup and ModelText
bounds, projects only these six fields, and refuses missing or malformed
provider values. An empty list means the provider reported no priority errors.

The provider's 2026-11-21 guide supplies shortened examples for all three
result types. Their free text is redacted in
`test/fixtures/ai-speaking/grading-v2-error-priority.provider-sample.json`. A
live no-speech result returned an empty list. The provider says `name_vi` is
AI-generated and awaits Academic approval.

Completed asynchronous Speaking grading jobs may already contain results
written before this field existed. Their read-only decoder accepts the old
shape and supplies an empty list; new provider responses still require the
field.

## Rollout

The asynchronous job result is persisted as a closed JSON shape, and the
current N-1 reader refuses unknown result properties. Therefore a
compatibility-only release that accepts and ignores `error_priority` in stored
job results must be deployed before a release starts persisting this field.
This release sequence also protects overlapping workers and rollback. Do not
deploy the combined reader-and-writer change as the first stage.

## Consequences

The `/v2` response addition is optional for existing clients. OpenAPI and the
Integration Guide describe the new field. No raw provider response or
unrecognized entry properties are exposed.
