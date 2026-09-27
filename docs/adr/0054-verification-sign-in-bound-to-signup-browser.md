# ADR-0054: Sign in on email verification only in the browser that signed up

- Status: Accepted
- Amends: ADR-0022, ADR-0024

After a customer verifies their email, the Customer Web should land them in the console without asking for their password again. A verification link that signs in whoever opens it would turn a harmless "verify on someone's behalf" link into account takeover. Three cases show why: an attacker who pre-registers a victim's email with the attacker's own password would get the victim working inside the attacker's account (pre-account takeover); a forwarded or leaked link would grant a session for 24 hours; and a mail scanner that runs JavaScript would sign itself in. So a verification token signs in only the browser holding its **Signup Browser Binding**: a random nonce the Customer Web sets in a `__Host-` HttpOnly cookie when that browser registers or resends, which AIHUB stores only as a hash on the token.

Verifying the email and signing in are separate outcomes of `POST /v1/auth/verify-email`:

- **Verification** is idempotent. Any holder of an unexpired token activates the account, and the response is `204`.
- **Verification Sign-in** happens at most once per token, and only when the request carries the matching binding. It runs through the same session issuance as login: the account must be active, and it creates a new Refresh Session under ADR-0024. The response is the login envelope (`200`) with the refresh cookie.

Claiming the one-time Verification Sign-in, creating its Refresh Session, and the verification that precedes them are one durable transaction. A session write that fails therefore rolls back the whole request: the account stays unverified and the sign-in stays available, so the same link verifies and signs in on a retry while the token is unexpired. A request that only verifies stores no session.

Verification keeps its existing consumption: the first verification marks the token `verified`, and a resend marks older tokens `superseded`. Sign-in is tracked separately on the token. A token signs in at most once, only while it is `verified` and unexpired, and verification by anyone else never spends that sign-in. A scanner or a second device can therefore verify the email first, and the signup browser can still sign in until the token expires. After sign-in, reusing the token returns `204`.

## Considered Options

- **Always redirect to login after verification.** Rejected: safe, but the team wants the password step removed for the common case.
- **Sign in whoever opens the link.** Rejected because of the pre-account-takeover, leaked-link, and scanner cases above.
- **Refuse to verify without the binding.** Rejected: a customer who signs up on a laptop and opens the mail on a phone would be stuck.
- **Keep the binding only in the Customer Web backend.** Rejected: that backend is not trusted to tell AIHUB to issue a session for a user, so AIHUB must check the binding itself.

## Consequences

- Clients that send no binding, and tokens issued before this change, keep today's behaviour: verify only, `204`. The backend can therefore deploy before the Customer Web.
- Each token is bound to the browser that requested it. A resend from another browser rebinds the new token to that browser, or leaves it unbound; an attacker who resends cannot receive the link, because it goes to the owner's mailbox.
