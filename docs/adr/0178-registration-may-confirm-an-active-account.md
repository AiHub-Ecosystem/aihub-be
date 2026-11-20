# ADR-0178: Registration may confirm that an email has an active account

- Status: Accepted
- Date: 2026-11-20
- Related issue: [#354](https://github.com/AiHub-Ecosystem/aihub-be/issues/354)
- Amends: [ADR-0022](0022-aihub-local-user-authentication.md) (registration is outside its "auth failures expose no account existence" rule); [ADR-0123](0123-pending-registration-is-replaced-and-verification-reenters-its-password.md) (the enumeration signal that record noted in passing becomes a stated decision)
- Related: [ADR-0096](0096-authentication-rate-limits-by-caller-and-address.md), [ADR-0025](0025-password-recovery-boundary.md), [#139](https://github.com/AiHub-Ecosystem/aihub-be/issues/139)

## Context

`POST /v1/auth/register` answers `409 AUTH_IDENTITY_UNAVAILABLE` when the
normalized email belongs to an account that is `active` or `disabled`, or when
the username is held. A caller can therefore learn whether an address has an
AIHUB User Account by sending it with a fresh random username. Registration is
the only public auth route that does this: login answers one Login credential
failure for every account state and spends hash work on unknown addresses
(#322), and Password Recovery answers generically.

No record stated that the difference was intended. ADR-0123 noted it only as a
consequence of the pending-registration replacement rule.

## Decision

**Registration may confirm that an email address has an active or disabled
AIHUB User Account. This is a deliberate, recorded exception.** The remaining
signal is exactly "an account exists in `active` or `disabled`"; the two states
are not distinguishable from each other, and an account still in
`pending_verification` is not revealed because ADR-0123 replaces it and answers
`201`.

A held username stays distinguishable by design. A Username is published to
other members of an Organization in the roster and in Organization Audit Events,
so it is not secret data; an attacker separating "email taken" from "username
taken" gains nothing beyond the email fact this decision already accepts.

**Residual risk, accepted.** An attacker learns that a given address is a
registered AIHUB customer. The realistic harms are targeted phishing or
credential stuffing at that address, and reconstruction of part of AIHUB's
customer list. It is not an account-takeover vector: Password Recovery still
requires control of the mailbox, and no credential is disclosed by the
response. The response body carries no detail about the stored identity and
stays the single generic message "Email or username is unavailable".

**This decision does not accept unlimited probing.** The controls that bound it
today are the per-IP registration limit and the per-caller, per-address
authentication-email budget; a probe of an already-active address spends
neither the address-wide email ceiling nor a token, because the conflict is
raised before the recipient reservation. Because those limits are keyed to the
caller's address, an attacker spread across many addresses can probe at a rate
those controls do not bound. A durable attempt counter keyed to the normalized
address, alongside the existing recipient fingerprint, is the follow-on this
record requires; see Consequences.

## Considered Options

- **Close the signal: answer the same accepted response whether or not the
  email exists, and email the existing holder instead.** Rejected. It makes
  registration assert `status: "pending_verification"` for an account that was
  not created, contradicts the response contract published in the integration
  guide, needs a new email kind and template, needs a username check that does
  not require an email, and cannot be rolled out without deploying the Customer
  Web in step. It also cannot be reverted cheaply once clients stop handling
  `409`. The information it protects is narrow, and ADR-0123 already published
  it.
- **Reserve the address's email budget before the conflict check, so every
  probe costs the target's allowance.** Rejected. It lets a stranger burn the
  nine-message daily ceiling of an address they do not control, which is exactly
  the harm ADR-0096 removed.
- **Answer `201` with a fabricated pending account for an email that already
  has an active one.** Rejected. This is the closing option in its cheapest
  form and still requires a new email kind, a queue-time decision about who
  receives the notice, and a response the integration guide would have to
  describe as untrue.

## Consequences

- The integration guide and the public error catalogue state that a `409`
  on registration means the email or username is taken, without claiming the
  response hides account existence. No runtime behavior changes with this
  record.
- Registration remains outside the generic-failure rule that login, Password
  Recovery, and verification resend follow. A future route must not copy this
  exception without its own decision.
- **Required follow-on:** count registration attempts per normalized address,
  using the same keyring-derived HMAC fingerprint the recipient ceiling uses
  (`auth_email_recipient_rate_limits`), and record the count before the conflict
  is decided. Enforcement thresholds follow once that counter produces
  evidence; the counter is opened as its own issue so that a threshold is not
  invented before there is data.
- No security event or metric is added by this record. The authentication
  security-event set stays limited to the flows that already record one.
- Because the disclosure is accepted, the response-time difference between an
  eligible and an ineligible address at `forgot-password` and
  `resend-verification` no longer needs equalizing to protect eligibility.
  [#1986](https://github.com/AiHub-Ecosystem/aihub-be/issues/1986) may record
  that difference as accepted risk and close on its measurement alone; the
  generic reply and the existing limits stay unchanged either way.
