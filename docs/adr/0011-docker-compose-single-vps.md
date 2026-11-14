# ADR-0011: Docker Compose on a single VPS with documented exit triggers

- Status: Accepted; per-tier topology by ADR-0085; exit triggers amended by ADR-0165
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

Stage A runs on self-hosted VPS infrastructure with a 2–3 person team and no
dedicated DevOps. Kubernetes, ECS, or Cloud Run would add operational surface
the team cannot staff.

## Decision

Deploy with Docker Compose on a single VPS. Host nginx (already owning ports
80/443 and certbot) terminates TLS; Postgres and Redis are existing shared
services, not exposed on host ports.

The architecture carries explicit **exit triggers**
([10-deployment-roadmap §N.5](../superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md)):
measured thresholds that, once crossed, mandate re-evaluating this deployment
model. The triggers are the decision's safety valve — staying on Compose is
acceptable only while its preconditions hold.

Deployment specifics that this ADR anchors:

- 90-second graceful shutdown (`stop_grace_period: 90s`): grading requests can
  run up to 60 s; Fastify must finish accepted requests before the old service
  stops.
- Expand-only migrations while both release versions may run
  (`CREATE TABLE`, nullable `ADD COLUMN`, `CREATE INDEX CONCURRENTLY` are
  permitted; drops and renames are not).
- Self-hosting Postgres for a commercial product makes **backups the single
  largest operational risk**: hourly encrypted dumps with tiered retention,
  plus quarterly restoration rehearsals — an unverified backup is not a backup.

## Consequences

- ADR-0085 later recorded the per-tier blue-green cutover topology (Production
  and Sandbox slots plus one temporary candidate) that production now uses;
  this ADR remains the foundation decision for self-hosting.
- The shared host is a 2-vCPU machine shared with AI Speaking's services;
  resource budgets must come from measurement on that host, not from the
  earlier four-vCPU estimate.
