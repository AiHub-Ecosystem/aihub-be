# Organization invitation send-rate boundary

Status: accepted

Issue #98 bounds invitation-send attempts without adding a second limiter: after authorization and email normalization, each new invitation attempt consumes fixed-window allowances of 5 per 15 minutes per inviting User Account, 20 per 15 minutes per Organization, and 3 per 24 hours per normalized invited email shared across Organizations. The checks run in that order and return the existing generic `429 RATE_LIMITED` response with the first rejected window's retry time; a rejection creates no durable invitation, sends no email, and creates no audit event, while a completed idempotency replay consumes no new allowance and an email-delivery failure does not refund the attempt.

The existing auth limiter remains the protection seam. Redis failure uses its bounded process-local fallback so invitations remain available under a coarse per-process ceiling rather than turning a Redis outage into an invitation outage; the public contract does not disclose Redis state or which dimension rejected the request. The three policy values live in one configuration object, and OpenAPI/Postman describe the existing rate-limited response without exposing the invited email's account state.
