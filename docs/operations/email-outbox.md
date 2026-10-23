# Email outbox: dispatch and operational signals

This runbook describes the Email Delivery Request lifecycle, the accepted
dispatch controls in [ADR-0117](../adr/0117-prioritize-and-pace-email-outbox-dispatch.md),
and the operational signals to alert on. The outbox lifecycle is decided in
[ADR-0074](../adr/0074-transactional-email-outbox.md). ADR-0117's dispatch
controls and alert rules are implemented in this release; they become active
when the release and migration are deployed.

## The alerting boundary

**No alerting transport ships in this repository.** There is no broker, no
webhook client, no PagerDuty or Opsgenie integration, and no notifier
abstraction, because there is no runtime that owns a delivery to an alert
backend. ADR-0074 requires that a terminal failure _trigger an alert_; it does
not require the application to be the thing that pages.

AIHUB emits the signals monitoring consumes and stops there:

| Signal                                                                     | Where it is read                        |
| -------------------------------------------------------------------------- | --------------------------------------- |
| `aihub_email_delivery_failed_total{kind="..."}`                            | `/metrics` on each application instance |
| `aihub_email_outbox_oldest_queued_age_seconds{kind="..."}`                 | `/metrics`, read from Postgres          |
| `aihub_email_delivery_cancelled_timestamp_seconds{kind,reason}`            | `/metrics`, read from durable rows      |
| one `ERROR` log line per terminal failure, context `[EmailOutboxDispatch]` | the instance log                        |
| one `ERROR` log line per provider credential outage, same context          | the instance log                        |

Prometheus scrapes each environment's `/metrics` endpoint through a dedicated
loopback-only Nginx listener on the Production host and the restricted SSH
tunnel. Public API and Sandbox `/metrics` paths remain blocked; see the scrape
and firewall setup in [aihub-observability.md](aihub-observability.md).

Configuring the rule that turns those into a page is deployment-owned
([`deploy-vps.md`](deploy-vps.md)). That split is deliberate: adding a broker to
the application would put a third-party availability dependency in the same
process as request handling, and would make an alert delivery failure
indistinguishable from the delivery failure it was reporting.

The seam is a single function,
`reportTerminalEmailDeliveryFailure` in
`src/modules/auth/email-delivery/infrastructure/email-outbox-poller.scheduler.ts`. It is the
one place a terminal failure becomes observable, so a change to alerting
plumbing has one function to move rather than a policy scattered across the
dispatch path.

## Accepted #438 dispatch controls

The controls keep one poller and database per environment while sharing a
send-rate reservation across Production and Sandbox. They require the #438
release and migration in each enabled environment.

Before enabling the shared cap, an operator must:

1. Check the Resend team's current `rate_limit.limit` and
   `rate_limit.duration` in the [Account Usage API](https://resend.com/changelog/account-usage-api).
2. Set `AIHUB_EMAIL_SEND_RATE_LIMIT` to a positive cap no greater than the
   verified limit, and `AIHUB_EMAIL_SEND_RATE_DURATION_MS` to the verified
   duration converted to milliseconds. The limiter spaces reservations by
   `ceil(duration_ms / limit)`; use the same values in Production and Sandbox.
   AIHUB will not query Resend at runtime.
3. Point both environments at the same dedicated limiter Redis URL/keyspace.
   Keep it separate from the environment-specific `REDIS_URL` values.
4. Record the verified limit, duration, configured cap, and date checked here.
   Do not record the Resend API key.

Production and Sandbox require the same positive
`AIHUB_EMAIL_SEND_RATE_LIMIT` and `AIHUB_EMAIL_SEND_RATE_DURATION_MS` values.
The runtime fails startup if either is missing in production mode. Do not
deploy the release while the verification record below is pending.

| Resend Usage API limit | Duration | Configured cap | Verified on |
| ---------------------- | -------- | -------------- | ----------- |
| 10 requests            | 1000 ms  | 10             | 2026-10-22  |

The limiter fails closed: if it cannot reserve a send slot, the request stays
queued without spending an attempt. Do not configure a per-instance fallback.
Once implemented, the queue-age rule below alerts on this condition. The cap
covers both environments, while priority and invitation fair share apply only
within each environment; Sandbox can consume account send capacity also used by
Production.

Dispatch order within each environment is password reset, verification
(registration and resend share the same kind), MFA enabled/removed notices, then
invitations. Rows within a priority tier remain oldest first. When invitation
groups compete, a ten-row batch allows at most five invitation rows for any one
Organization and at most five for any one inviter while another group still
has eligible invitations. If a competing group's entire queue fits within its
share, the remaining group can use those slots to fill the batch. Queued rows
carry opaque Organization and inviter IDs and clear them at terminal state.
Older invitation rows without those IDs are
temporarily treated as one legacy group; their ciphertext is not opened for a
backfill.

## What is emitted

One event and one increment per terminal failure, normally exactly once and at
least once (see the end of this section):

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
notification is already recorded is not claimed again.

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

The notification lease is fenced the same way (#989). Each claim's identity is
the lease expiry it wrote: a later claim is only possible once that instant has
passed, and writes a strictly later one. Recording the report and handing the
claim back both require the row's lease to still be that value, so a reporter
whose lease lapsed while another instance claimed the row changes nothing; it
neither records nor releases the newer claim.

Reporting is therefore at least once, not exactly once. The signal is emitted
before the report is recorded, and the metric, the log line and the database are
not one transaction: if recording fails after the signal went out, or the
process stops in between, the row is claimed again and the same request id is
reported again. A rare repeat is the price of never losing a terminal failure.
Treat the request id in the log line as the key when counting distinct
failures.

## Terminal delivery failure

`AIHUBEmailDeliveryTerminalFailure` fires when
`aihub_email_delivery_failed_total` increases in a 15-minute window, summed per
`job` and `kind`. Attempts run at 0, +1 minute, and +5 minutes, so the window
covers one whole retry schedule. It is `warning`, the same as the other email
alerts. The counter is exposed at 0 for every kind when the application starts;
without that, Prometheus reads the first failure of a kind after a restart as no
increase.

`kind` separates the six flows (`verification_email`,
`password_reset_email`, `organization_invite_email`,
`mfa_enabled_notification`, `mfa_removed_notification`,
`api_key_near_expiry_notification`). `job` says whether it was Production or
Sandbox. A `kind`-specific rise points at that flow's recipient domain or its
`from` address, which is the usual cause.

First steps:

1. Read the failed rows with the query in
   [What an operator can read](#what-an-operator-can-read). Quote the `id`, never
   an address.
2. Read `last_error_code`. It is one of four codes. `timeout` means the attempt
   ran past the five-second provider timeout; `provider_rejected` means the
   provider declined the API request; `provider_permanent_rejection` means a
   `400` or `422` response ended the request after one attempt;
   `outcome_unknown` means a process died after reserving the last attempt, so no
   answer was recorded (see above). Nothing else about the provider's answer
   survives to this point, by design.
3. If `EmailProviderOutage` is also firing, the provider is the cause; follow
   [Provider-wide outage backoff](#provider-wide-outage-backoff-adr-0122-410).
4. If one `kind` fails and the others do not, check that flow's recipient domain
   and the `from` address first.

## Provider response classification

The Resend adapter passes only the HTTP status and `Retry-After` header to the
poller. It never reads or stores the response body.

- `400` and `422` are terminal. The request fails after one attempt with
  `provider_permanent_rejection`, then uses the existing durable terminal
  failure signal.
- `401` and `403` indicate a provider credential configuration problem. The
  attempt count and previous `last_attempt_at` are restored, the request stays
  queued for five minutes, and that poller pauses the rest of its claimed batch
  and skips new claims for the same interval. It emits one bounded
  `ERROR [EmailOutboxDispatch]` configuration signal until a send succeeds.
- `429` restores the attempt count and defers at least until `Retry-After`.
  Delta-seconds and HTTP dates are accepted; an absent or invalid value uses a
  60-second delay. The retry timestamp is stored in the lease expiry so the row
  cannot be claimed early.
- Other non-success responses, including unclassified `4xx`, retain the normal
  bounded retry schedule and `provider_rejected` code.

### Release order for the permanent rejection code

The current reader rejects an unknown `last_error_code`, which can abort a
claim of unreported terminal failures. Add `provider_permanent_rejection` to
the reader's accepted vocabulary in a reader-only release while continuing to
write `provider_rejected`. After that release is deployed to every instance,
release the writer that stores `provider_permanent_rejection` for `400` and
`422`. Do not deploy the new writer while any older reader remains active.

### Release order for the bound payload envelope (#439)

A payload is sealed in an envelope that names its version. Version `v1` carries
no associated data. Version `v2` authenticates the request it belongs to, so a
ciphertext copied onto another row or kind does not open. A `v1` reader cannot
open `v2`, and a poller that cannot open a payload cancels the request without
a signal, so the order of releases decides whether a deploy can lose mail:

1. **Reader release.** Every instance opens `v1` and `v2` and accepts the error
   code `payload_unreadable`, and still writes `v1`. The poller still cancels a
   payload it cannot open.
2. **Writer release**, only after the reader release is running on every
   instance of Production and Sandbox, and the previous slot has stopped. Instances
   write `v2`, and the poller fails an unreadable payload with
   `payload_unreadable` instead of cancelling it.
3. **Drain.** Rows sealed as `v1` leave the queue within 24 hours for the
   credential kinds (the longest credential lifetime) and within 14 days for
   `api_key_near_expiry_notification` (its notice window), plus one sweep
   interval. Keep the `v1` reader until then.

Never deploy the writer release while an older reader can still claim a row. The
operator CLI seals notices too (`src/cli/operator-notification-client.ts`), and
it runs from the same image: move it through the same two releases in the same
order, and do not run its sweep from an older image after the writer release.

The configuration pause and its one-alert suppression are per poller process.
If several application instances independently observe the same credential
problem, each can emit one signal until one of its sends succeeds.

## Provider-wide outage backoff (ADR-0122, #410)

HTTP `5xx`, `429`, timeouts, and rejections from the configured Resend `fetch`
call open one account-wide circuit across Production, Sandbox, and all poller
instances. Those failures do not consume request attempts. The shared
full-jitter backoff starts at five seconds and caps at five minutes; a valid
`429 Retry-After` remains a minimum and can extend the cooldown. After each
cooldown, one real queued request is allowed as the account-wide probe. `5xx`,
`429`, and transport failures keep or extend the circuit; any other HTTP response
closes it. `401` and `403` close the outage circuit because the provider
responded, while retaining the existing per-poller five-minute configuration
hold. Message-specific failures keep the #449 classification.

The unlabeled gauge `aihub_email_provider_outage_duration_seconds` reports the
shared circuit's current duration on `/metrics`. The `EmailProviderOutage`
rule fires after five minutes only while queued mail exists. The per-kind
oldest-queued-age alert remains at 15 minutes. Account-wide protection is fully
active after the #410 release is deployed to every Production and Sandbox
poller. Redis stores this circuit state temporarily; if Redis loses it, a poller
can send an early probe, and the next provider-wide failure opens the backoff
again. Pollers fail closed while Redis is unavailable.

The stable outbox request ID remains the Resend idempotency key. Resend retains
those keys for 24 hours. The `api-key.near-expiry` notification can remain
queued for up to 14 days under ADR-0120, so an ambiguous handoff retried after
Resend's 24-hour retention expires may send a duplicate. Preserve the 14-day
notification window; the no-duplicate guarantee applies only within the
provider's key-retention period.

## Credential expiry alerts; other cancellations do not

A request is `cancelled` when its credential is superseded, expired, revoked, or
otherwise no longer actionable before handoff — a user resends a verification
email, or an invitation is revoked. Superseded, revoked, and other non-expiry
cancellations remain expected lifecycle handling and do not alert.

Credential expiry is different: an increase in queued credentials expiring
before dispatch is an operational failure signal. The bounded cancellation
metric labeled by `kind` and `reason` reads durable outbox state, and the alert
selects only `reason="credential_expired"`. A process restart after the
database transition does not lose the signal. `summary.cancelled` in the per-pass log line
(`email outbox pass claimed=... cancelled=N failed=N deferred=N`) remains the
visibility for routine cancellations.

A credential-bearing request older than the longest credential lifetime (24
hours) is also cancelled as `credential_expired`, at the start of every pass
and without being opened. MFA notices have no credential; an equally old MFA
notice is cancelled as `not_actionable`. Both paths erase the queued payload
without opening it.

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
that too. For these two gauges, `kind` is the only label.

A #438 alert fires when oldest queued age exceeds 15 minutes for any `kind`.
The Prometheus rule is in `ops/monitoring/alert.rules.yml`. A healthy request
is sent on its first pass (every 5 seconds) or retried
at +1 and +5 minutes, so 15 minutes is past the whole retry schedule. A request
held back because its payload is sealed with a key version this instance lacks
waits 5 minutes between claims, so a key removed too early shows up here too.

Read `aihub_redis_unavailable_total{seam="email_send_rate"}` first: it counts
every time the send-rate limiter could not get a send permit, a rate
reservation or a recorded provider failure from Redis (Redis absent, a command
that failed or timed out, or a reply the script never returns). A real denial,
such as the next send slot not being due yet or the provider cooling down, is
not counted. A counter that rises with `deferred` means the limiter's Redis, not
the provider, is what stops dispatch.

`deferred=N` in the per-pass log line counts requests handed back without an
attempt. A steadily non-zero value has two usual causes, and a queued row with
`attempts = 0` and a `lease_expires_at` a few seconds ahead of now points at
the second:

- A key version was removed while queued requests still needed it; restore the
  key before those requests age out.
- The send-rate Redis answers more slowly than its command timeout, or not at
  all, so no send permit or reservation is granted. Every pass hands the request
  back after 5 seconds and nothing is sent. Measure a round trip to that Redis
  from the application container before changing anything else.

## Backpressure refusals (#635)

The queue-age gauges above are what an operator reads; the API reads the same
queue to decide whether a new request can still be honoured. `POST
/v1/auth/register`, `POST /v1/auth/resend-verification`, `POST
/v1/auth/forgot-password` and `POST /v1/organizations/{organization_id}/invitations`
ask the outbox for the age of its oldest queued request of the kind they would
add. When that age has used 75% of the credential lifetime, the route answers
`503 EMAIL_DELIVERY_BACKLOGGED` with `Retry-After` and writes nothing: no
account, token, invitation or delivery request, and no rate-limit budget is
spent. A 24-hour verification or invitation token therefore refuses past an
18-hour backlog, and a one-hour reset token past 45 minutes.

`Retry-After` is the time the oldest request has left before it expires, held
between 30 seconds and 15 minutes so a client checks again soon. The age is read
from the same query as the gauges, shared for 10 seconds between requests. When
that read fails the request is admitted as before: a missing signal does not
refuse sign-ups.

`aihub_email_outbox_backpressure_refusals_total{kind}` counts refusals, and
`AIHUBEmailOutboxBackpressureRefusing` warns when it rises. A rising count
means dispatch is not keeping up: read `AIHUBEmailOutboxQueueAgeAboveBound`
first, then the provider circuit and the send-rate limiter in the sections
around this one. The refusals end by themselves once the oldest request is sent
or expires.

## Send-rate limiter Redis unavailable

`AIHUBEmailSendRateRedisUnavailable` fires when
`aihub_redis_unavailable_total{seam="email_send_rate"}` has risen for 10
minutes. The send-rate limiter keeps its pacing and the provider-outage state in
a Redis shared by every environment. When it cannot get an answer from that
Redis it refuses to send and hands the request back, so email queues up without
a single terminal failure. The queue-age alert fires too if it lasts 15 minutes.

First steps:

1. Confirm `deferred` stays above zero in the per-pass log line and that queued
   rows have `attempts = 0`.
2. Check the Redis answers at all from the application host: the counter counts a
   Redis that is absent, a command that fails or times out, and a reply the
   script never returns.
3. A refused key or command (`NOPERM`) is swallowed, so the log shows nothing.
   Compare the Redis user's access list with the line in
   `ops/vault/README.md`; a change to the limiter's scripts needs the matching
   change there.
4. A command that takes longer than the limiter's command timeout fails every
   time. Compare the timeout with the application's round trip to that Redis
   ([Redis round trip and command timeouts](redis-round-trip.md)) before
   changing anything else.

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

## Authentication recipient counters

The authentication email ceiling in [ADR-0096](../adr/0096-authentication-rate-limits-by-caller-and-address.md)
uses `auth_email_recipient_rate_limits`. It stores a versioned HMAC, a fixed
24-hour window, and a count capped at nine; it does not store the recipient
address. The HMAC key is derived from the Vault-provided Email Outbox keyring.
Expired rows are removed at startup and hourly, so physical deletion can lag
the 24-hour expiry by up to one hour. The table is included in Postgres dumps.

To check active versions or overdue cleanup without reading fingerprints:

```sql
SELECT key_version, count(*) AS active_rows
FROM auth_email_recipient_rate_limits
WHERE expires_at > now()
GROUP BY key_version;

SELECT count(*) AS expired_rows
FROM auth_email_recipient_rate_limits
WHERE expires_at <= now();
```

Keep old Email Outbox key versions until queued ciphertext no longer needs them
and their recipient counters have expired and been removed.

## Daily email budget

Production and Sandbox reserve from the same durable row in the Production
database through a dedicated least-privilege PostgreSQL login. Set the identical
AIHUB_EMAIL_DAILY_SEND_BUDGET in both deployments. Provision
email_send_budget_url in both Vault database bundles with a URL to that shared
database; the login needs only SELECT, INSERT, and UPDATE on
email_daily_send_budgets. Keep this URL separate from each environment's outbox
database URL. The migration creates the table in both app databases, but only
the shared Production database receives reservations.

The reservation count resets at midnight UTC. Each provider attempt reserves
one slot before handoff and failures count conservatively. Invitations may use
at most 80% of the configured budget, reserving the remainder for verification,
password reset, and MFA email. Over-budget requests stay queued until reset; an
actionable credential is retried at its expiry so the normal cancellation path
can erase it.

Resend's [published Free plan](https://resend.com/pricing) currently lists
100 emails per day and 3,000 per month. On 2026-10-22, the authenticated
Production Resend credential returned those daily and monthly limits from the
[Account Usage API](https://resend.com/changelog/account-usage-api). The
selected budget of 80 leaves 20% daily headroom and stays below the monthly
limit over 31 days. Before production rollout, check
`emails.daily.limit` and `emails.monthly.limit` for the account, record the
values and date below, and set the same cap in both deployments below the
verified daily and monthly limits. Do not enable dispatch with a pending
account check.

| Resend account daily limit | Resend account monthly limit | Selected daily budget                | Checked on |
| -------------------------- | ---------------------------- | ------------------------------------ | ---------- |
| 100                        | 3,000                        | 80 (at most 2,480 in a 31-day month) | 2026-10-22 |

The AIHUBEmailDailySendBudgetNearLimit alert fires at 80% of the configured
budget. That matches the invitation cutoff, so an operator is alerted when
protected recovery capacity is first held back. The daily metric reports both
the shared day's reserved sends and its configured cap. The rule is in
ops/monitoring/alert.rules.yml and follows the #369 alert receiver routes.

## What never appears in a signal

The dispatch path cannot emit an email address, a token, a message body, a raw
request body, or a raw provider response. This is structural rather than a matter
of care at each call site:

- **The event carries three fields**, and a test pins the payload whole rather
  than field by field, so an address appearing in it fails whether it came from a
  new field or an edit to the format.
- **The counter has one bounded label**, `kind`, whose five values are fixed in
  `src/common/observability/metrics.ts`. A recipient cannot become a series.
- **`last_error_code` and `cancel_reason` are CHECK-constrained** to
  `^[a-z0-9_]{1,64}$` in `prisma/migrations/0027_email_delivery_requests/migration.sql`.
  Free-text provider output cannot be stored even by mistake.
- **The provider error is never propagated.** `errorCodeOf` in the poller maps
  every provider failure to one of the two codes; the original error stays in the
  provider adapter's scope.
- **The payload is erased at every terminal state**, so it is not available to be
  logged even later.

A provider SDK error typically echoes the recipient, the token, and a slice of
the submitted body. Tests assert that none of it reaches the event, the metric
exposition, or the row.
