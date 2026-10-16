# ADR-0096: Scope authentication rate budgets to caller and address

- Status: Accepted
- Date: 2026-10-13
- Related issue: [#422](https://github.com/AiHub-Ecosystem/aihub-be/issues/422)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) for authentication email rate limits; [ADR-0086](0086-trust-single-nginx-hop-for-caller-ips.md) for authentication rate-limit IP dimensions and forwarding trust
- Related: [ADR-0025](0025-password-recovery-boundary.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md), [#278](https://github.com/AiHub-Ecosystem/aihub-be/issues/278), [#436](https://github.com/AiHub-Ecosystem/aihub-be/issues/436)
- Email-budget implementation: Implemented in #422; production behavior and cleanup remain unverified until deployment evidence is recorded. The #278 pre-verification gate is specified in the amendment below and awaits implementation.

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

## Amendment for issue #278 (2026-10-14)

This amendment specifies when the login failure budgets above are checked. It does not change their thresholds, fixed-window behavior, or Redis outage fallback.

**Pre-verification gate.** Before verifying a password or second-factor proof, check both applicable budgets without consuming them. Keep `login_email` at five failed proofs per normalized email and caller IP in a fixed 15-minute window, and `login_ip` at 20 failed proofs per caller IP in a fixed five-minute window. The allowed failures are the first five or 20 respectively; the next request is refused with `429 RATE_LIMITED` and `Retry-After` before proof verification. Only an incorrect password or second-factor proof consumes budget. Successful authentication and a login that has not yet supplied its second factor do not consume budget.

**Surfaces and caller IP.** Use this shared check for `POST /v1/auth/login`, `POST /v1/auth/web-sessions`, `POST /v1/auth/mfa/enrollment`, `POST /v1/auth/mfa/enrollment/confirm`, and `DELETE /v1/auth/mfa`. Standard login and direct Bearer callers use Fastify's trusted `request.ip`. Web Session creation uses the validated end-user IP after the existing BFF client-secret guard. On the Bearer-protected MFA routes, no `X-AIHUB-Client-Secret` means a direct caller whose key uses `request.ip`; ignore `X-AIHUB-End-User-IP` in this case. When the secret header is supplied, authenticate it before trusting the end-user IP. An invalid supplied secret is refused with 401; unavailable secret configuration or a valid secret with a missing or malformed end-user IP fails with `503 AUTH_WEB_SESSION_UNAVAILABLE`, following the existing Web Session guard. Do not fall back to the BFF peer IP in that BFF mode.

**Concurrent requests.** A request that passed the non-consuming check may finish verification even if concurrent failures fill a budget afterward. Requests checking after the budget is full are refused. This snapshot behavior keeps successful attempts from consuming a failure budget.

**Shared-IP trade-off.** The `login_ip` budget is shared by accounts using the same selected caller IP. Reaching 20 failures in five minutes can therefore refuse correct logins from other accounts behind that address, including an office or NAT address, until its fixed window expires. This is accepted; verified Customer Web BFF requests use the end-user address to avoid applying one BFF peer's budget to all its users.

**Distributed-guessing trade-off.** No counter is keyed by account alone. Both budgets include the caller IP, so guesses at one account's password from many addresses are bounded only by the cost of the password hash and, when the account has enrolled one, by the TOTP factor, which is optional. An account-wide counter would let a stranger keep the owner locked out, the harm this ADR exists to remove, so none is added. This is accepted. Reopen it if an account that holds an Organization's API keys is taken over by password guessing, or if a customer requires a stronger bound. The options then are to require a second factor for Organization owners (see #667) or to add an escalating delay per account that does not refuse the owner's own correct attempt.

### Acceptance boundaries for #278

- Every listed route checks the applicable `login_email` and `login_ip` budgets before verifying password or second-factor proof; over-budget requests with correct or incorrect proof receive the same `429 RATE_LIMITED` response and retry hint.
- A per-route HTTP spec exercises the shared limiter and proves pre-verification refusal, including that a correct login is refused after the relevant budget is exhausted and can succeed after the window expires.
- A failure from one caller IP cannot consume the `login_email` allowance for the same normalized address from another IP. The separate shared `login_ip` impact for callers behind one IP is documented above.
- Existing and unknown email addresses remain indistinguishable when a budget is exhausted.
- Redis outage behavior remains the per-process best-effort fallback described above and is covered by tests.
