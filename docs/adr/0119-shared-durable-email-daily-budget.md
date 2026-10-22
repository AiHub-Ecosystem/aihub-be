# ADR-0119: Share a durable daily email budget across provider-account deployments

- Status: Accepted
- Date: 2026-10-22
- Related issue: [#375](https://github.com/AiHub-Ecosystem/aihub-be/issues/375)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (dispatch reservation accounting)

## Context

Production and Sandbox have separate transactional outboxes but use one Resend
account. A per-database or Redis-only daily counter therefore cannot protect
that account quota across both deployments or survive a Redis reset.

## Decision

Both deployments reserve against one row in the Production PostgreSQL database,
through a separate least-privilege connection configured in their Vault
connection bundles. The atomic row stores the current UTC date, the effective
daily budget, and reservations; its date advances at midnight UTC. Each provider
attempt reserves once before handoff, including attempts that later fail, so
uncertain outcomes consume capacity conservatively. A database error denies the
reservation and leaves the outbox request queued without spending an attempt.

Organization invitations may reserve at most 80% of the daily budget. The
remaining capacity is shared by verification, password reset, and MFA mail
across both deployments. Invitation requests denied at the cutoff stay queued
until the budget resets. The poller brings credential-bearing rows back at
credential expiry so the existing cancellation path erases expired payloads.

Operators set the same positive budget in both deployments below the Resend
account's verified daily limit and monthly limit divided across 31 days. Check
the account's Usage API values and record them in the email-outbox runbook before
enabling the release. A Prometheus gauge reports reserved sends and the cap; the
existing Alertmanager rule set warns at 80% of the cap, when invitation
capacity is held back.

## Consequences

The dedicated connection and one atomic database row coordinate Production,
Sandbox, and replicas without relying on Redis durability. If the shared
database is unavailable, sends pause and the existing queue-age alert reports
the backlog. The counter does not include messages sent outside AIHUB, so
operators must leave quota headroom and recheck provider usage. The daily
reservation cap is not an exact mirror of Resend's live quota; manual changes to
the plan or to the configured cap require an operator review.
