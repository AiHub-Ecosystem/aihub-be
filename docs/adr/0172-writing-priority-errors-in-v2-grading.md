# ADR-0172: Publish provider-ranked Writing priority errors in `/v2`

- Status: Accepted; amended by [ADR-0177](0177-sanitize-and-bound-ai-service-grading-responses.md)
- Date: 2026-11-17
- Amends: [ADR-0143](0143-public-v2-serves-ai-writing-v3-grading.md) decisions 1 and 2

AIHUB publishes provider `data.error_priority` as the required
`data.error_priority` field in each public `/v2` Writing grade result, beside
`overall_assessment`, preserving the provider's list order and strings. The
provider response must include the field (an empty list means no priorities);
missing or malformed values are contract violations, never silently replaced by
an empty list. The schema accepts at most three entries, ranks 1–3, and the
three documented groups while leaving error codes open-ended. The dev provider
returned this shape for both grading tasks on 2026-11-17; captures are kept in
`test/fixtures/ai-writing/grade-v3-task{1,2}-error-priority.capture.json`.
Additional provider fields on an entry are ignored and are not published.
An older completed `/v2` idempotency result may predate the field; a read-only
legacy decoder preserves its absence on replay without grading again. Fresh
provider responses still require the field.

On rollback, N-1 replays the stored idempotency response body without grading
again; the added field may be present and is ignored by the older response
reader, as required by [ADR-0128](0128-persisted-values-and-vault-document-keys-are-read-before-they-are-written.md).
