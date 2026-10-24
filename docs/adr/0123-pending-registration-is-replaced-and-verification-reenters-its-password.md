# ADR-0123: A pending registration is replaced by the next one, and verification re-enters its password

- Status: Accepted; a refused recipient reservation leaves a pending registration untouched, added by [#932](https://github.com/AiHub-Ecosystem/aihub-be/issues/932)
- Date: 2026-10-23
- Related issue: [#932](https://github.com/AiHub-Ecosystem/aihub-be/issues/932)
- Amends: [ADR-0054](0054-verification-sign-in-bound-to-signup-browser.md) (what verification proves about the credential)

## Context

Registration creates a `pending_verification` User Account that holds the password hash its registrant chose. Verifying the email activates that account without any further proof of the credential. While the account is pending, a second registration for the same email or username answers `409 AUTH_IDENTITY_UNAVAILABLE`, password recovery does nothing for it, and nothing expires it.

The person who controls a mailbox therefore cannot be sure that the account they activate uses a credential they chose. Someone who registered an address that is not theirs can set a password they know, and the owner of the mailbox activates the account by opening the verification mail. ADR-0054 stops the automatic sign-in for that case, but not the activation.

## Decision

Three rules together:

1. **A registration replaces the pending account for its email.** Registering again with an email whose account is still `pending_verification` replaces that account's password hash and username, supersedes its open verification tokens, and queues one verification email. A verification email still queued for a superseded token is cancelled with the existing `credential_superseded` reason. The account keeps its id; its `updated_at` records the replacement. An email whose account is active or disabled, and a username held by a different account, still answer `409 AUTH_IDENTITY_UNAVAILABLE`. A registration whose recipient reservation the address-wide ceiling refuses (ADR-0096) replaces nothing: the pending account keeps its credential, username, open verification token and `updated_at`, no replacement token is created, and the answer is `email_delivery_status: "suppressed"` — the same answer a new email at a full ceiling gets, so nothing about the account is revealed. The delivered link stays the account's only usable one, which is what the mailbox's owner still holds (#932).
2. **Verification re-enters the registration password.** A verification token issued while a deployment setting is on carries a marker that verifying it needs the password of the registration it belongs to. A wrong password answers `400 AUTH_VERIFICATION_PASSWORD_INVALID` and does not spend the token; the fifth wrong password spends it. The setting defaults to off, and a token issued while it is off, or before it existed, verifies as before. A password sent for a token that does not require one must still match. Both routes that consume a verification token take the password: `verify-email` and the Customer Web BFF's Web Session verification route. The consumption itself refuses a token that needs the password unless the caller passes the stored hash it verified, re-read under the account lock, so a route cannot skip the check. This is specified in [#1023](https://github.com/AiHub-Ecosystem/aihub-be/issues/1023).
3. **Pending registrations expire.** An account still pending seven days after its creation or latest replacement is deleted, with its identity and tokens, which releases its email and username. This is specified in [#1022](https://github.com/AiHub-Ecosystem/aihub-be/issues/1022).

The response to a registration for a pending email is the same as for a new email: `201`, `pending_verification`, and the delivery status the recipient reservation gives. Registration hashes the password before it touches the database on both paths. The replacement and a verification of the same account serialize on the User Account row, which both take before any token, in the lock order password reset uses (ADR-0025).

## Considered Options

- **Replace on re-registration only.** Rejected: the last registrant wins. An attacker who registers after the mailbox's owner makes the owner's next click activate the attacker's password.
- **Re-enter the password at verification only.** Rejected: the mailbox's owner cannot activate an account whose password they do not know, and the registrant's hold on the address lasts until expiry and can be renewed by registering again.
- **Choose the password at verification, and drop it from registration.** Rejected for now: it is the strongest option, but it changes the registration contract and the Customer Web flow together, and the two sides deploy separately.
- **Both rules together (chosen).** An account becomes active only when the person holding the link also knows the credential of the latest registration. An attacker cannot hold the mailbox, and the owner can always register again to take the slot back.

## Consequences

- **The weakness stays open until the setting is on.** Clients cannot send the password until the Customer Web does, so the backend ships with the setting off, the Customer Web follows, and turning the setting on is a separate production step ([#1024](https://github.com/AiHub-Ecosystem/aihub-be/issues/1024)). Tokens issued before then keep today's behaviour.
- Two registrants can overwrite each other's pending registration. Nobody activates an account with a credential the mailbox owner did not confirm, and the existing registration rate limits and per-recipient email budget bound the overwriting.
- The only enumeration signal a registration gives is whether the email has an active account, which `409` already gave.
- A person who registered, lost the link, and registered again with a different password needs the password of the latest registration.
- Argon2 verification at `verify-email` is bounded by the existing verification rate limit and Argon2 queue.
