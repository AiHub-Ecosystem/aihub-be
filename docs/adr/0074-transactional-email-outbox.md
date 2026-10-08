# ADR-0074: Transactional outbox for account and invitation email

- Status: Accepted; transaction-handle boundary amended by [ADR-0083](0083-email-delivery-transaction-handle-lifetime.md)
- Date: 2026-10-05
- Related issue: [#230](https://github.com/AiHub-Ecosystem/aihub-be/issues/230)
- Amends: [ADR-0025](0025-password-recovery-boundary.md) (email delivery only), [ADR-0038](0038-bearer-management-idempotency-scope.md) (invitation email delivery only)

## Context

Registration, verification resend, password recovery, and organization invitation send commit durable account or token state before calling Resend with a five-second timeout. Waiting for that provider couples committed work to a network call, while enqueueing only after commit can lose the email if the process stops between the two operations. Email delivery therefore needs a durable handoff committed with the state it serves.

## Decision

Each affected operation writes its Email Delivery Request in the same PostgreSQL transaction as its account, token, or invitation mutation; invitation audit evidence stays in that transaction as well. A failed transaction commits neither the mutation nor the request. The HTTP request returns after this commit and never waits for Resend. Redis is not used as a queue because it is ephemeral protection/cache state, not durable control-plane storage.

Registration and invitation creation keep their `201` success status and add `emailDeliveryStatus: "queued"`. That value is the acceptance-time result: it confirms AIHUB accepted the request for dispatch, not that a provider accepted it or that it reached an inbox. Verification resend remains a generic bodyless `202`. Password recovery remains a generic `202` for known, unknown, pending, and disabled accounts; its copy says that AIHUB accepted a request to send instructions only if the account is eligible and does not confirm email delivery. These two generic routes do not expose whether an outbox item exists. Provider delivery failure is no longer a synchronous `503`; a failure to commit durable state and its outbox request remains a safe `5xx`.

## Delivery lifecycle and retry

An Email Delivery Request is `queued` after durable acceptance, `provider_accepted` after the email provider accepts the API request, `failed` after bounded attempts stop without provider acceptance, or `cancelled` when its credential is superseded, expired, revoked, or otherwise no longer actionable before provider handoff. `provider_accepted` does not mean inbox delivery. The worker checks that the credential is still actionable before dispatch; cancellation is expected lifecycle handling and does not page.

Each attempt has an explicit five-second timeout. A request receives at most three attempts total, with retries after one minute and five minutes, and no attempt runs after the token expires. A stable Resend `Idempotency-Key` is used for each outbox item so an uncertain timeout can be retried without sending the same email twice; Resend documents 24-hour key retention, which exceeds this retry window ([Resend documentation](https://resend.com/changelog/idempotency-keys)).

Each existing application instance runs the poller against its own environment database (Production or Sandbox). PostgreSQL claims use `FOR UPDATE SKIP LOCKED` plus a lease to coordinate concurrent instances; the stable provider idempotency key covers retries after an uncertain handoff. No separate worker container is added. On provider acceptance, retry exhaustion, or cancellation, the encrypted message payload is erased while delivery state and attempt evidence remain available for operations. Terminal `failed` items produce a safe structured event and metric and trigger an alert; logs contain no email address, token, message body, or raw provider response.

## Security and preserved boundaries

The outbox retains the email payload only as authenticated ciphertext under a versioned AEAD key supplied through Vault. The key version accompanies the ciphertext, and old key versions remain available while queued items need them. Plaintext message content and tokens are never persisted or logged. Token tables continue to store hashes; the encrypted outbox payload is erased when the request reaches a terminal state.

Existing per-route rate limits and token lifetimes do not change: verification and organization invitation tokens remain valid for 24 hours, and password reset tokens for one hour. A delivery failure does not refund a rate-limit attempt. Invitation idempotency replay returns the original `201` result without creating another outbox item or spending another allowance.

## Consequences

Registration may create a pending account whose verification email later fails; the user can use the existing resend flow, which stays generic. Invitation records likewise remain durable if dispatch ultimately fails. Operators can distinguish queued, provider-accepted, cancelled, and failed requests, while callers are never told that an email reached an inbox. The token-bearing ciphertext and Vault key lifecycle add security and rotation work, accepted to preserve a stable token across process restarts and bounded retries.
