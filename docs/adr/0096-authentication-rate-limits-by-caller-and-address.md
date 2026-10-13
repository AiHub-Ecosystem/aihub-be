# ADR-0096: Scope authentication rate budgets to caller and address

- Status: Accepted
- Date: 2026-10-13
- Related issue: [#422](https://github.com/AiHub-Ecosystem/aihub-be/issues/422)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) for authentication email rate limits; [ADR-0086](0086-trust-single-nginx-hop-for-caller-ips.md) for authentication email dimensions
- Related: [ADR-0025](0025-password-recovery-boundary.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [#278](https://github.com/AiHub-Ecosystem/aihub-be/issues/278), [#436](https://github.com/AiHub-Ecosystem/aihub-be/issues/436)
- Implementation: Implemented in #422; production behavior and cleanup remain unverified until deployment evidence is recorded.

## Context

The email limits for registration, verification resend, and password recovery currently use separate email-only counters. A stranger can consume those counters for someone else's address. The `login_email` counter has the same risk if #278 checks it before verifying a password. Caller-only limits do not bound email sent to one address by many callers.

ADR-0074 commits each eligible authentication email request in the same PostgreSQL transaction as its account or token mutation. The current rate limiter is Redis-backed, so a Redis counter cannot atomically represent only outbox requests that successfully commit.

## Decision

**Registration and recovery requests.** Share one strict budget across `register`, `resend-verification`, and `forgot-password`: three syntactically valid requests per normalized address and caller in a fixed 24-hour window, starting with the first request. Count the request before account eligibility is known, including unknown or ineligible addresses. Keep existing per-route IP limits. Exhausting this caller-and-address budget returns the existing `429 RATE_LIMITED` behavior with its retry hint.

**Authentication email ceiling.** Independently cap committed verification and password-recovery email requests at nine per normalized address in a fixed 24-hour window. The window starts with the first committed outbox request. Count only outbox inserts committed with their account or token mutation; unknown or ineligible targets and rolled-back transactions consume no address-wide email allowance. Enforce the counter in the same PostgreSQL transaction as the outbox insert, using a keyed HMAC of the normalized address rather than storing that address in the counter. Derive purpose-specific HMAC keys with HKDF from the versioned Email Outbox keyring already supplied by Vault. Writers check every retained key version and keep an active window on the version that created it; new windows use the current version. Delete expired counter rows during startup and hourly cleanup. Keep each old key version available until its counters expire and are cleaned up so rotation cannot reset an active window.

When the address-wide ceiling is full, `forgot-password` and `resend-verification` keep their generic responses and write no outbox item. `register` still creates the pending account, writes no outbox item, and returns `email_delivery_status: "suppressed"`; its response contract must represent that value. The caller-and-address request budget is still consumed. After the window expires, the user can request a verification email through resend. The ceiling counts requests committed to the outbox, not provider acceptance or inbox delivery; a later delivery failure does not refund it.

**Login attempts.** Keep `login_email` at five failed attempts per caller and normalized address per fixed 15-minute window. Only failed credential attempts consume it. #278 owns checking this budget before credential verification; this ADR changes its keying. Standard login uses the trusted caller IP. Web Session login uses the validated end-user IP supplied by the BFF after its client-secret guard, as established by #436.

**Redis outage.** Keep the existing per-process fallback for Redis-backed caller budgets. During an outage, strict per-caller budgets are best-effort per process; the PostgreSQL address-wide outbox ceiling remains shared and durable.

## Considered options

- Keeping the email-only limit as the strict budget lets any stranger lock out the address owner; rejected.
- Giving each mail route a separate caller-and-address budget permits a caller to bypass the limit by switching routes; rejected.
- Counting the aggregate email ceiling in Redis before account lookup can charge unknown targets or failed PostgreSQL transactions and cannot atomically enforce the outbox cap; rejected.
- Letting the address owner bypass a full address-wide ceiling would weaken the spam backstop and require account-dependent behavior; rejected. The accepted ceiling can delay recovery for up to the rest of its window.

## Consequences

The strict caller budget no longer lets one caller consume another caller's allowance. A distributed set of callers can still reach the nine-message address-wide ceiling, after which even the owner receives the generic response without a new email until the window expires. This trade-off bounds queued authentication email while preserving generic recovery responses.

The durable HMAC counter is a pseudonymous identifier with a 24-hour lifetime and is included in the shared VPS PostgreSQL store and its backups. The existing shared-host at-rest risk applies. [The personal-data inventory](../privacy/personal-data-inventory.md) records the implementation and its pending production verification; #422 must verify expiry cleanup after deployment.

## Acceptance boundaries

- A different caller exhausting its own shared mail-request budget cannot consume the owner's caller-and-address budget on any of the three routes, unless the address-wide ceiling itself is full.
- Across the three routes, a caller's fourth syntactically valid request for one normalized address within the fixed 24-hour window is refused, including requests for unknown or ineligible addresses; existing per-route IP limits remain effective.
- The address-wide limit admits at most nine committed outbox requests per normalized address in its fixed 24-hour window, across the three routes. Concurrent transactions cannot exceed it; unknown/ineligible targets and rolled-back transactions do not spend it.
- At the address ceiling, recovery and resend remain generic and write no email. Registration still creates the pending account and returns `email_delivery_status: "suppressed"` without an outbox request.
- `login_email` remains five failures per 15 minutes and is keyed by caller plus normalized address for standard and Web Session login. Tests cover the shared credential-check path; #278 proves pre-verification gating and failed-attempt consumption on its owned routes.
- Redis outage behavior and the per-process limit of its fallback are documented and tested; the PostgreSQL email ceiling remains enforced during Redis outage.
- The personal-data inventory records the HMAC counter before release, including its 24-hour deletion behavior and backup/at-rest status.
- `pnpm verify` passes before implementation is merged. Production behavior remains unverified until #422 is deployed and observed.
