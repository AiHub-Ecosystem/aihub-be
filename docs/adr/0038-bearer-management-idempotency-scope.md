# ADR-0038: Bearer management idempotency scope and failure boundary

Status: accepted; invitation email delivery amended by [ADR-0074](0074-transactional-email-outbox.md)

Date: 2026-09-22; related issue: [#97](https://github.com/AiHub-Ecosystem/aihub-be/issues/97)

> The no-outbox sentence below records the decision made for #97. ADR-0074 replaces it for invitation email delivery while preserving this ADR's idempotency boundary.

Bearer management mutations reuse the existing durable Postgres idempotency seam with a management scope of one Organization, one AIHUB User Account, one mutation type, and one client-supplied key. The invitation operation honors an optional key; after current authorization, validation, and email normalization, a successful result is replayed with status `201`, fresh request metadata, and `Idempotent-Replay: true`, while a missing key preserves the existing invitation behavior. A completed record is replayed without re-running the mutation even if the invitation has since changed state; different keys retain the existing invitation supersede behavior. Reservation precedes the existing invitation transaction and email delivery; no parallel store or outbox is introduced. Known email-delivery failure remains retryable and may supersede the undelivered token, but uncertainty after the mutation succeeds and idempotency completion fails stays pending until the 24-hour retention window so a retry cannot send a second invitation. Storage failures return the existing retryable `500 INTERNAL_ERROR` mapping. The `Idempotency-Key` header is documented only on the invitation-create route, and existing `X-API-Key` gateway behavior remains unchanged.
