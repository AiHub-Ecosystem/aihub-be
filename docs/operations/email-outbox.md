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

A request that used its last attempt is only given up through this same
notification path. Emitting it directly from the transition would race the
reconciler on the other instance, which can claim the row the moment that
transition commits, and two instances would report one failure.

An attempt is reserved before the provider is called, so a process that dies in
between leaves a row that is `queued`, already at the cap, and excluded from
every later claim — it would keep its ciphertext and stay silent. Each pass
gives such a row up as `failed` with `last_error_code = 'outcome_unknown'`
before it claims anything, so no fourth provider call is made and the alert
still goes out. That code means the outcome of the last attempt was never
recorded, which is different from `timeout` or `provider_rejected`: neither the
provider's answer nor its failure was ever observed.

A process can exit between the write that makes a request terminal and the
callback that emits its event, which would lose the alert for good: the row is
terminal, so no later pass claims it. The row therefore records when its
notification went out (`failure_reported_at`), and every pass reconciles the
terminal rows that have no such record before it ends. A pass that starts after
the one that failed a request still emits its event, and a request whose
notification is already recorded is never reported twice.

Reconciling takes a lease (`failure_notify_lease_expires_at`) rather than
recording the report immediately, because both halves matter. Two instances
reconciling at once must produce one event between them, so the claim excludes
the other instance; and an instance that dies, or a callback that throws, must
not consume the alert, so the row stays claimable until the signal was actually
emitted. A live lease with no `failure_reported_at` is therefore an alert this
instance is still owed, and it becomes claimable again when the lease lapses.

The dispatch lease fences the writer as well as excluding the other instance.
A batch that outruns its lease — a database stall, a paused process — can be
reclaimed, and the instance that lost the row may still be holding it in memory.
Every transition after a claim therefore requires that `lease_owner` still be
this instance, so the stale one's update matches nothing instead of spending an
attempt the new owner is spending or clearing the new owner's lease.

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
(`email outbox pass claimed=... cancelled=N failed=N deferred=N`) is the
visibility for it.

A queued request older than the longest credential lifetime (24 hours) is also
cancelled as `credential_expired`, at the start of every pass and without being
opened. Its credential can no longer work, so it can never be sent; cancelling it
is what erases a payload that no instance can decrypt.

## Queue backlog: when dispatch stops

The terminal-failure counter only moves when a request gives up. If no instance
dispatches at all — the poller is not running, every claim errors, or every
request is waiting on a key version this instance does not hold — nothing gives
up, and that counter stays flat. Two gauges cover that case:

| Signal                                                     | Meaning                                              |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| `aihub_email_outbox_queued{kind="..."}`                    | Email Delivery Requests waiting for dispatch         |
| `aihub_email_outbox_oldest_queued_age_seconds{kind="..."}` | how long the oldest waiting request has been waiting |

Both are read from the table at scrape time rather than from the poller, so they
keep rising while dispatch is stopped. If the table cannot be read, the series
disappear instead of repeating their last value, so an `absent()` rule catches
that too. `kind` is the only label.

Suggested alert condition: the oldest queued age exceeds 15 minutes for any
`kind`. A healthy request is sent on its first pass (every 5 seconds) or retried
at +1 and +5 minutes, so 15 minutes is past the whole retry schedule. A request
held back because its payload is sealed with a key version this instance lacks
waits 5 minutes between claims, so a key removed too early shows up here too.

`deferred=N` in the per-pass log line counts requests handed back for that
reason. A steadily non-zero value means a key version was removed while queued
requests still needed it; restore the key before those requests age out.

## What an operator can read

The durable row keeps delivery state and attempt evidence after the payload is
erased, so a failed request can be investigated without any customer data:

```sql
SELECT id, kind, status, attempts, last_attempt_at, last_error_code,
       cancel_reason, created_at, completed_at, failure_reported_at,
       failure_notify_lease_expires_at
FROM email_delivery_requests
WHERE status = 'failed'
ORDER BY completed_at DESC;
```

On a terminal request `payload_ciphertext` is `NULL` and the lease columns are
released. `attempts` is the count used, `last_error_code` the bounded cause, and
`completed_at` when the request was given up on. For a `cancelled` row read
`cancel_reason` instead; `last_error_code` is not set.

Three rows are states an operator will meet that no pass resolves on its own, and
none of them is a lost email:

- `failure_reported_at IS NULL` on a `failed` row means an instance still owes
  its alert. The next pass reconciles it.
- A `queued` row naming a key version this deployment does not hold was claimed
  by an instance that could not read it. The instance that does hold the key
  claims it unchanged, with its attempts untouched. The cause is a keyring that
  dropped an id still in use by queued rows.
- A `queued` row with `attempts` at the cap lost the outcome of its last attempt,
  so no pass can retry it or finish it. It is given up on deliberately rather
  than called a fourth time, and the payload stays until the row is resolved by
  hand.

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
