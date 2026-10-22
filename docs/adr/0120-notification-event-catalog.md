# ADR-0120: Notification Event catalog

- Status: Accepted
- Date: 2026-10-22
- Related issue: [#608](https://github.com/AiHub-Ecosystem/aihub-be/issues/608), [#976](https://github.com/AiHub-Ecosystem/aihub-be/issues/976), [#977](https://github.com/AiHub-Ecosystem/aihub-be/issues/977), [#980](https://github.com/AiHub-Ecosystem/aihub-be/issues/980), [#986](https://github.com/AiHub-Ecosystem/aihub-be/issues/986)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (actionability and stale cancellation for requests that carry no credential), [ADR-0117](0117-prioritize-and-pace-email-outbox-dispatch.md) (dispatch priority only), [ADR-0119](0119-shared-durable-email-daily-budget.md) (daily budget category only)

## Context

Every email AIHUB sends today follows a user action: registration, verification resend, password recovery, an invitation, or an MFA change. Each carries a credential or reports the act that was just taken. Nothing tells an Organization about a fact AIHUB notices on its own, and an API key that reaches its `expires_at` stops authenticating without warning.

The first such notice is an API key nearing expiry. Three follow-on channels are already planned for it: an in-app inbox (#976), Web Push (#977), and an Organization webhook (#980), which needs a stable event ID. Recording "this key was notified" on the key row, or deduplicating sent emails, would serve email only and leave each later channel to invent its own record.

The outbox (ADR-0074) dispatches through a per-kind handler table in Auth, `EMAIL_KIND_HANDLERS`. MFA notices already carry no credential, but every handler lives in Auth, a handler cannot check anything against the database before an attempt, and the stale pass cancels any queued row older than the longest credential lifetime, one day. A near-expiry notice needs a check against Identity's data before it is sent, and should survive an outage longer than a day while its keys are still active. Identity already imports the auth module, so a dispatch check that called from Auth into another module would form a Nest module cycle; #309 met the same problem on its read side.

Key rotation keeps the retired key's expiry (#986), so rotating does not renew an expiring key.

## Decision

### Notification Kind and Notification Event

A **Notification Kind** is one member of a closed, code-declared set. The first is `api-key.near-expiry`. Emitters, channels, and any later preference use only this vocabulary.

A **Notification Event** is the durable record that AIHUB observed one occurrence of a Notification Kind for an Organization. It stores references only: the kind, the Organization ID, the subject (for `api-key.near-expiry`, the API key ID), the subject's `expires_at` as observed, and the moment it was recorded. It stores no key name, recipient, or email address. It is unique by `(kind, api_key_id, expires_at)`, so one key and expiry produce one event however many times the sweep runs. Every channel is a delivery of an event; the event's ID is what a later webhook sends as its stable event ID.

The catalog lives in Identity, at `src/modules/identity/notifications/`, and the event table is Identity's. Identity already owns the API keys, Organizations, and memberships the notice is about, and its invitation flow already writes its own rows and an Email Delivery Request in one transaction through Auth's `EmailDeliveryRequestWriterPort`; the notice follows the same path. The operator command reaches the sweep through Identity's `public/` facade.

No retention job is added. Events hold only IDs and dates, one per key and expiry, under an active-key cap of five per Organization. The inbox in #976 stores per-user state and must decide retention for that state when it lands.

Emitting a notice is not an Organization Audit Event: audit records an actor's act, and the sweep is AIHUB observing a fact.

### Selection: the near-expiry sweep

An operator command, `pnpm cli notifications:sweep`, runs once a day per environment through the same host wrapper as the other scheduled jobs. It moves to one-shot containers with every other job under #433 and #495; it does not wait for them.

A key is eligible when it is active, not `internal`, has an `expires_at` within the next 14 days, and has no Notification Event for its current `expires_at`. Selection is a window ending 14 days ahead, not a band between 13 and 14 days, so a missed run catches up and a key created with less than 14 days of life is still notified. A key without an expiry is never notified. A key of a suspended Organization is not recorded, so restoring the Organization inside the window still notifies it. Every customer key in the environment's database is eligible, Customer Sandbox keys included; Production and Sandbox each run their own sweep.

Each key is notified once, at the 14-day mark. A second reminder later adds its milestone to the event's uniqueness instead of a new mechanism.

Recipients are resolved when the sweep runs: each active `owner` and `admin` membership whose User Account is active. An owner or admin who joins after the sweep does not receive that event's email.

In one PostgreSQL transaction, the sweep inserts each eligible key's event with `ON CONFLICT DO NOTHING` and, for the events that inserted, writes one Email Delivery Request per (recipient, Organization) listing every newly recorded key of that Organization. Two concurrent sweeps therefore queue one email, and a sweep that stops midway leaves no event without its email.

The sweep prints one JSON summary line (events recorded, emails queued, keys skipped) and exits non-zero on failure; the host wrapper supplies the heartbeat and failure alert as it does for the other jobs.

### Dispatch: handlers contributed to Auth's handler table

Auth remains the only writer and dispatcher of the outbox, and its per-kind handler table gains the notice's kind. A handler's render may now be asynchronous and may answer that nothing is left to send. The notice's handler reads its facts through a resolver port Auth declares, `ApiKeyNearExpiryNoticeResolverPort`, held in a slot Auth provides; Identity fills the slot when its provider is built, so Auth never imports Identity.

Immediately before an attempt, the handler rechecks that the Organization is active, the recipient still holds an active `owner` or `admin` membership with an active User Account, and each listed key is still active. The email lists only keys that remain active. When no key remains, or the recipient or Organization no longer qualifies, the request is cancelled with the existing `not_actionable` reason. The one-day stale cutoff does not apply to a notice: it is stale, and cancelled as `not_actionable` without being opened, once it is older than the 14-day notice window, by which time every key it lists has expired.

The notice does not reserve from the authentication recipient budget (`reserveAuthenticationEmailRecipient`), which protects authentication mail from abuse. The shared daily budget of [ADR-0119](0119-shared-durable-email-daily-budget.md) counts the notice in its invitation share, so recovery and verification mail keep the fifth reserved for them.

### Priority

The notice takes a new lowest dispatch tier, after `organization_invite_email`. The ADR-0117 order is otherwise unchanged.

### Message

The message follows #334: Vietnamese, with the expiry in Asia/Ho_Chi_Minh time labelled "giờ Việt Nam". It names each key by `name` and `id` and never carries a key value, prefix, or hash. Its copy is composed in Auth's message composer beside the other transactional email, outside the Resend adapter, and links to `${CUSTOMER_WEB_BASE_URL}/console/orgs/{organizationId}/api-keys`. Because rotation keeps the expiry, it tells the customer to create a replacement key and revoke the old one; the copy changes when #986 lets rotation set a new expiry.

### Not in this slice

No preference route or preference storage: with one kind and no stored choice, a route could only return a constant. The first slice that stores a real preference adds the route. No inbox, push, webhook, or second kind.

## Considered alternatives

- **A `near_expiry_notified_at` column on `api_keys`.** Smallest change, but it records one channel's state on Identity's table and gives the inbox, push, and webhook slices no shared event or stable ID.
- **A 13-to-14-day band with a 30-day per-Organization suppression**, as #608 first proposed. A missed daily run skips a key for good, and the suppression hides a second key expiring within the same 30 days.
- **One Email Delivery Request per Organization addressed to every owner and admin**, as #608 first proposed. The outbox payload carries one recipient; changing that for one kind would widen every kind's payload.
- **Auth calling into Identity for the dispatch check.** It forms a module cycle, because Identity imports Auth to write requests.
- **A separate `notifications` module.** Grilling first chose one; the code showed it would read four tables other modules own and rebuild the transactional path to Auth's writer that Identity's invitation flow already has, so the catalog moved into Identity.
- **Keeping the one-day stale cutoff for notices.** One cutoff for every kind, but a dispatch outage longer than a day would drop the only warning a key gets, since its event is already recorded.
- **A preference read route returning the default.** It would add a public contract with nothing behind it.

## Consequences

Later channels deliver an existing event rather than re-deriving "should this Organization hear about this key", and a webhook gets its stable event ID for free. Adding a kind means adding a catalog member, a sweep or emitter, and a handler; the outbox and its poller stay unchanged.

The outbox gains its first kind whose handler lives outside Auth. The `email_delivery_requests` kind check and Auth's kind list widen by one value, and the stale pass gains a per-kind cutoff. A handler that is not registered in a process leaves that kind's rows queued, and the existing 15-minute oldest-queued alert from ADR-0117 surfaces it.

The notice can lag behind invitations and recovery mail under load, by design. A customer who rotates instead of replacing still loses the key at the original expiry until #986 ships; the email says so.

The sweep is in the managed crontab, `ops/host-jobs/aihub.crontab`, which CD installs on deploy, so the push to `main` that carries it is what schedules it on the host.
