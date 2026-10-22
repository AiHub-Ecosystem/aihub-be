# ADR-0122: Coordinate provider-wide email outage backoff

- Status: Accepted
- Date: 2026-10-22
- Related issue: [#410](https://github.com/AiHub-Ecosystem/aihub-be/issues/410)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (provider-wide failure attempts and retry behavior), [ADR-0117](0117-prioritize-and-pace-email-outbox-dispatch.md) (account-wide coordination across environments)

## Context

The outbox currently spends an Email Delivery Request's bounded attempts on HTTP 5xx, timeouts, and connection failures. Production and Sandbox have separate outbox databases, but every AIHUB instance sends through the same Resend account. Per-row retries therefore keep calling a failing provider from every environment and can exhaust otherwise actionable requests.

## Decision

Treat HTTP 5xx, provider `429`, timeout, and a rejection from the Resend adapter's actual `fetch` call as provider-wide failures. These failures do not consume a message attempt. Catch transport rejections at the fetch boundary; do not depend on Undici-specific `cause.code` values. Other sender or programming errors retain their existing classification. `429` continues to honor `Retry-After` as a minimum delay.

Coordinate the outage circuit across every instance using the Resend account, including Production and Sandbox, through the existing shared Redis account keyspace. Start full-jitter exponential backoff on the first provider-wide failure, from a five-second base to a five-minute cap. A valid `429 Retry-After` may extend the cooldown beyond that cap. After a cooldown, allow one account-wide half-open probe. A `5xx` or `429` response, timeout, or transport rejection keeps or extends the circuit. Any other HTTP response closes it because Resend is reachable. `401` and `403` also close the outage circuit, but retain ADR-0074's per-poller five-minute credential-configuration hold and alert behavior.

Preserve ADR-0074 and #449 message classification: `400` and `422` fail terminally after one consumed attempt; `401` and `403` refund their attempt; `429` refunds its attempt; and other 4xx responses keep the existing bounded per-request retry policy. A provider-wide outage pauses new sends across the account and defers unsent claimed rows without spending attempts. Pollers continue stale-credential cancellation, pending attempt-release recovery, and terminal-failure reconciliation. In-flight provider calls finish under their existing timeout. The row ID remains the provider idempotency key across retries.

Store only temporary circuit state in Redis with a short TTL. If Redis loses that state, the next provider-wide failure opens the circuit again; the existing account-wide send limiter already prevents sends when Redis is unavailable. A rolling deployment only coordinates instances that understand this circuit, so the account-wide behavior is fully active after all Production and Sandbox pollers run the supporting release.

Expose the shared outage duration as an unlabeled `aihub_email_provider_outage_duration_seconds` gauge on `/metrics`. Add an `EmailProviderOutage` Prometheus rule for a duration over five minutes while queued mail exists. Keep the existing per-kind oldest-queued-age alert at 15 minutes. Document both thresholds in the email-outbox runbook.

Keep the outbox request ID as the stable provider idempotency key. Resend retains idempotency keys for 24 hours. Credential-bearing requests are still checked and cancelled before handoff; the `api-key.near-expiry` notification retains its accepted 14-day stale cutoff from ADR-0120. Therefore duplicate suppression is guaranteed only within Resend's 24-hour key-retention window. An ambiguous handoff retried after that window may send a duplicate; preserve the 14-day notification retention and document this limit.

## Consequences

Provider-wide outages no longer consume message attempts or drive the poller fleet into per-message retry traffic. One coordinated probe limits the recovery burst, while the existing queue-age alert remains independent of whether a poller is running. Redis loss can briefly reopen provider traffic until another failure is observed, and mixed-version deployments do not receive account-wide protection until every poller is upgraded. The no-duplicate guarantee is bounded by the provider's 24-hour idempotency retention; longer-lived `api-key.near-expiry` requests keep their 14-day delivery window with a documented duplicate risk after that boundary.
