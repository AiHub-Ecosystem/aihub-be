# Email outbox: terminal failure evidence

This runbook describes what an operator sees when an Email Delivery Request
stops without provider acceptance, and what to alert on. The outbox itself is
decided in [ADR-0074](../adr/0074-transactional-email-outbox.md); this document
covers the operational signal only.

## The alerting boundary

**No alerting transport ships in this repository.** There is no broker, no
webhook client, no PagerDuty or Opsgenie integration, and no notifier
abstraction, because there is no runtime that owns a delivery to an alert
backend. ADR-0074 requires that a terminal failure _trigger an alert_; it does
not require the application to be the thing that pages.

AIHUB emits the two signals an alerting rule consumes and stops there:

| Signal                                                                     | Where it is read                        |
| -------------------------------------------------------------------------- | --------------------------------------- |
| `aihub_email_delivery_failed_total{kind="..."}`                            | `/metrics` on each application instance |
| one `ERROR` log line per terminal failure, context `[EmailOutboxDispatch]` | the instance log                        |

Configuring the rule that turns those into a page is deployment-owned
([`deploy-vps.md`](deploy-vps.md)). That split is deliberate: adding a broker to
the application would put a third-party availability dependency in the same
process as request handling, and would make an alert delivery failure
indistinguishable from the delivery failure it was reporting.

The seam is a single function,
`reportTerminalEmailDeliveryFailure` in
`src/modules/auth/infrastructure/email-outbox-poller.scheduler.ts`. It is the
one place a terminal failure becomes observable, so a change to alerting
plumbing has one function to move rather than a policy scattered across the
dispatch path.

## What is emitted

Exactly one event per terminal failure, and one increment per terminal failure:

```text
aihub_email_delivery_failed_total{kind="verification_email"} 1
```

```text
ERROR [EmailOutboxDispatch] email delivery request edr_01J00000000000000000000000 exhausted its attempts kind=verification_email error=provider_rejected
```

The event is raised once, on the attempt that used the last of a request's three
attempts, not once per attempt. A retried request emits nothing, so the counter
measures abandoned requests rather than provider trouble.

Suggested alert condition: any increase of `aihub_email_delivery_failed_total`
over a window long enough to cover the retry schedule (attempts run at 0, +1
minute, and +5 minutes, so 15 minutes is a safe minimum). `kind` separates the
three flows; a `kind`-specific rise points at that flow's recipient domain or
its `from` address, which is the usual cause.

The `error=` value is one of two codes, `timeout` or `provider_rejected`.
`timeout` means the attempt ran past the five-second provider timeout;
`provider_rejected` means the provider declined the API request. Nothing else
about the provider's answer survives to this point, by design.

## Cancellation is not an alert

A request is `cancelled` when its credential is superseded, expired, revoked, or
otherwise no longer actionable before handoff — a user resends a verification
email, or an invitation is revoked. ADR-0074 calls this expected lifecycle
handling. It emits no metric and no event.

That is a load-bearing distinction: an alert rule that fired on cancellation
would page on routine user behaviour and train operators to ignore the one event
that matters. `summary.cancelled` in the per-pass log line
(`email outbox pass claimed=... cancelled=N failed=N`) is the visibility for it.

## What an operator can read

The durable row keeps delivery state and attempt evidence after the payload is
erased, so a failed request can be investigated without any customer data:

```sql
SELECT id, kind, status, attempts, last_attempt_at, last_error_code,
       cancel_reason, created_at, completed_at
FROM email_delivery_requests
WHERE status = 'failed'
ORDER BY completed_at DESC;
```

On a terminal request `payload_ciphertext` is `NULL` and the lease columns are
released. `attempts` is the count used, `last_error_code` the bounded cause, and
`completed_at` when the request was given up on. For a `cancelled` row read
`cancel_reason` instead; `last_error_code` is not set.

The `id` is safe to quote in a ticket. It is the correlation handle between the
alert, this row, and the instance that emitted the event.

## What never appears in a signal

The dispatch path cannot emit an email address, a token, a message body, a raw
request body, or a raw provider response. This is structural rather than a matter
of care at each call site:

- **The event carries three fields**, and a test pins the payload whole rather
  than field by field, so an address appearing in it fails whether it came from a
  new field or an edit to the format.
- **The counter has one bounded label**, `kind`, whose three values are fixed in
  `src/common/observability/metrics.ts`. A recipient cannot become a series.
- **`last_error_code` and `cancel_reason` are CHECK-constrained** to
  `^[a-z0-9_]{1,64}$` in `database/migrations/0027_email_delivery_requests.sql`.
  Free-text provider output cannot be stored even by mistake.
- **The provider error is never propagated.** `errorCodeOf` in the poller maps
  every provider failure to one of the two codes; the original error stays in the
  provider adapter's scope.
- **The payload is erased at every terminal state**, so it is not available to be
  logged even later.

A provider SDK error typically echoes the recipient, the token, and a slice of
the submitted body. Tests assert that none of it reaches the event, the metric
exposition, or the row.
