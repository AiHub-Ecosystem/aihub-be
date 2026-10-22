# ADR-0117: Prioritize and pace email outbox dispatch

- Status: Accepted
- Date: 2026-10-21
- Related issue: [#438](https://github.com/AiHub-Ecosystem/aihub-be/issues/438), [#449](https://github.com/AiHub-Ecosystem/aihub-be/issues/449), [#410](https://github.com/AiHub-Ecosystem/aihub-be/issues/410), [#557](https://github.com/AiHub-Ecosystem/aihub-be/issues/557)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (dispatch ordering and credential-expiry cancellation alerts only)

## Context

ADR-0074's poller claims ten rows in oldest-first order and sends them serially. That lets a sustained invitation backlog delay password-reset and verification messages until a credential expires. Each application instance also paces itself independently, while Resend applies its request-rate limit to the team account. Production and Sandbox have separate outbox databases and environment-specific Redis connections, but they use the same Resend account.

Resend's Account Usage API reports the team's rate limit as `rate_limit.limit` and `rate_limit.duration` ([Account Usage API](https://resend.com/changelog/account-usage-api)). The actual limit for AIHUB's account must be verified by an operator; it is not assumed here.

ADR-0074 treats all cancellation as expected lifecycle handling. That is correct for superseded and revoked credentials, but an expired credential can indicate that dispatch capacity or the poller failed long enough to lose useful mail. Issue #438 also requires that expiry to be observable.

## Decision

### Per-environment priority and invitation fair share

Each environment keeps its own outbox and poller. Within that environment, dispatch priority is:

1. `password_reset_email`
2. `verification_email` (first sign-up and verification resend share this kind)
3. `mfa_enabled_notification` and `mfa_removed_notification`
4. `organization_invite_email`

Rows within the same priority tier are ordered by `created_at`, then `id`. This priority and fairness policy does not coordinate queue ordering between Production and Sandbox.

Invitation fair share applies only when competing invitation groups are queued in the same environment. In a ten-row claim batch, an Organization or inviter may contribute at most five invitation rows while another group still has eligible invitations. If a competing group's entire queue fits within its share, the remaining group may use those slots to fill the batch. The [Organization Invitation Send Limit](0039-organization-invitation-send-rate-boundary.md) continues to govern invitation creation; it is a different policy.

Queued invitation rows store opaque Organization and inviter IDs for this scheduling decision. Clear both IDs when a row becomes terminal (`provider_accepted`, `failed`, or `cancelled`). Existing queued invitation rows without these IDs form one temporary legacy group; do not decrypt their payloads for a backfill. The five-row cap applies to that group when another invitation group is competing.

### Account-wide send-rate cap

All AIHUB instances using the Resend account, including Production and Sandbox, share one dedicated Redis connection and keyspace for an account-scoped send-rate reservation. This connection is separate from each environment's cache/protection `REDIS_URL`. Both environments use the same configured cap and shared limiter state.

An operator verifies the account's `limit` and `duration` through Resend's Account Usage API, sets an explicit configured cap no greater than that verified rate, and records the verified values, chosen cap, and verification date in the email-outbox runbook. AIHUB does not query the Usage API at runtime. The limiter sends at a steady pace with no accumulated burst allowance.

The limiter reserves capacity before an attempt is spent. If the shared Redis reservation cannot be made, leave the request queued and do not increment its attempt count. Do not fall back to a per-instance cap. Existing retry and provider-response classification remain per request under #449; provider-wide outage handling remains #410's concern. This ADR does not change the serial poller or add adaptive concurrency; #557 remains separate.

The rate cap is shared across environments, but priority and invitation fair share are not. Sandbox traffic can use account send capacity that Production could otherwise use; no Production reservation is introduced.

### Queue and expiry alerts

Alert when the oldest queued request of any kind exceeds 15 minutes. This uses the existing per-kind backlog and oldest-age gauges and makes a shared-limiter outage visible even when invitations are the only queued kind. The Prometheus rule belongs in `ops/monitoring/alert.rules.yml`; alert receiver configuration remains deployment-owned.

Count cancellation by bounded `kind` and `reason` from durable outbox evidence, and alert only for `reason="credential_expired"`. A committed expiry cancellation must remain observable across a process restart; an in-memory-only increment is insufficient. Superseded, revoked, and other non-expiry cancellations stay routine and do not alert.

## Acceptance contract for #438

- A claim pass in either environment selects password resets before verification, verification before MFA notices, and MFA notices before invitations; same-kind rows are FIFO.
- Under invitation competition, no Organization or inviter supplies more than five of ten claimed invitation rows while another group still has eligible rows. If a competing group's queue fits within its share, a remaining group can use the unused slots to fill the batch.
- Every send reserves from the same account-scoped limiter across Production, Sandbox, and all replicas. The configured rate is operator-set from the verified Usage API limit and duration, sends have no bursts, and a limiter failure leaves the request queued without spending an attempt.
- Per-kind oldest-queue age alerts after 15 minutes for every kind. Credential-expiry cancellations have a separate durable, bounded signal and alert; other cancellations do not.
- Invitation Organization and inviter IDs exist only while queued. Legacy queued invitations without IDs use the temporary legacy group.
- #438 does not change per-request retries/classification from #449 or introduce adaptive concurrency from #557.

## Consequences

Password-reset and verification email no longer wait behind invitations in the same environment. Sign-up verification remains in the protected verification lane with resends. MFA notices are below recovery and verification mail but above invitations. Continuous protected mail can delay invitations; the accepted priority order has no invitation minimum-rate reservation.

The shared Redis dependency can stop sends across both environments. Fail-closed behavior protects the account cap but grows the queue until Redis recovers, with the 15-minute queue-age alert providing the operational signal. A manual cap can drift from Resend's current account limit, so operators must recheck and update both environments when the provider limit changes.

Invitation IDs add two temporary scheduling fields to queued rows. The legacy group avoids opening already-sealed payloads but cannot provide exact per-Organization or per-inviter fairness for those rows until they drain.

The implementation adds nullable scheduling fields, so existing queued requests remain readable and legacy invitations need no payload rewrite. The new strict Vault connection field and required production rate settings must be prepared before rollout. Follow the coordinated cutover and rollback steps in the deployment runbook; this ADR does not claim the change is deployed.
