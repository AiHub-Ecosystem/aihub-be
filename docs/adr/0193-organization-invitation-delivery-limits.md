# ADR-0193: Organization invitation limits apply at delivery

- Status: Accepted — scope authorized for issue [#444](https://github.com/AiHub-Ecosystem/aihub-be/issues/444) on 2026-11-16
- Date: 2026-11-16
- Related: [ADR-0039](0039-organization-invitation-send-rate-boundary.md), [ADR-0074](0074-transactional-email-outbox.md), [#444](https://github.com/AiHub-Ecosystem/aihub-be/issues/444)
- Amends: [ADR-0039](0039-organization-invitation-send-rate-boundary.md) (the email-only ceiling no longer rejects invitation requests)

## Context

ADR-0039 applies the same email-only invitation limit before an invitation is created. Since Self-serve Organizations can be created freely, an attacker can spend that allowance and make unrelated Organizations receive `429` when inviting the same address. Issue #444 requires isolation between Organizations while still bounding delivery to one address.

## Decision

- Keep the strict 3-per-24-hour invitation limit keyed by the inviting Organization and normalized email. Keep the per-user and per-Organization request limits.
- Apply the shared 3-per-24-hour normalized-email ceiling in the email dispatcher. When that ceiling is full, defer the queued invitation email until its window resets; do not reject or roll back the Organization's invitation request.
- A deferred invitation remains queued and spends no provider attempt. Its existing credential lifetime continues to bound how long it can wait; expired credentials are cancelled by the existing delivery maintenance.
- Preserve the `/v1` response contract: accepted invitations continue to report `email_delivery_status: queued`.

## Consequences

One Organization can no longer exhaust another Organization's request-time allowance for an address. A recipient can still receive at most three dispatched invitation attempts in the fixed 24-hour window, while later accepted invitations may be delivered after the window resets or expire before then. The existing Auth rate limiter remains the shared protection seam.
