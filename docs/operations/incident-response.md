# Incident response

How AIHUB declares, handles, communicates, and learns from an incident. Sized
for one responder running a B2B API that customers integrate against (#293).

Alerts tell someone that something is wrong ([alert catalog](alert-catalog.md),
[observability](aihub-observability.md)). This document says what happens next.

## Who responds, and when

| Role             | Who                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Responder        | The repository maintainer, @lengocanh2005it. Receives every alert in the catalog (#291). |
| Backup responder | **None named.** See [Escalation](#escalation).                                           |
| Incident lead    | The responder, unless they hand the role to someone else in the incident record.         |

**Hours:** Monday to Friday, 09:00 to 18:00 Vietnam time (UTC+7), excluding
Vietnamese public holidays. Outside these hours response is **best effort**:
critical alerts still page the responder's phone, but no response time is
promised. The [integration guide](../integration-guide.md#10-getting-help)
tells customers the same thing; change both together.

Inside working hours the targets are:

| Severity | Acknowledge      | First customer message |
| -------- | ---------------- | ---------------------- |
| SEV1     | 30 minutes       | 1 hour                 |
| SEV2     | 2 hours          | 4 hours                |
| SEV3     | next working day | none required          |

### Escalation

There is no backup responder yet, so an unanswered page is not escalated to
anyone. The owners of shared components below are not on call for AIHUB; they
are contacted, not paged. Naming a backup and an escalation rule is #830.

### Contact sheet

Contact details are kept in the responder's password manager, not in this
public repository. The sheet there must hold one reachable route for each row.

| Party                                             | Why you would call them                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Responder, backup responder                       | Incident lead                                                          |
| Shared Postgres cluster owner                     | Database down, credential suspected (#298)                             |
| Redis and monitoring host operator                | Redis down, alerting down (#348, [register](shared-infrastructure.md)) |
| Object storage (SeaweedFS) operator               | Uploads or charts failing, credential suspected (#350)                 |
| VPS provider support and the control-panel holder | Host unreachable, VM stopped from outside, disk snapshot (#381)        |
| AI Writing team                                   | Writing grading failing or returning contract violations               |
| AI Speaking team                                  | Speaking grading failing                                               |
| Legal counsel                                     | Suspected personal-data breach (#380)                                  |

## What counts as an incident

Declare an incident for any of these. No SLOs are defined yet (#292); when they
are, a fast burn-rate alert is added here.

- A critical alert from the catalog, or `AIHUBEdgeProbeFailed`.
- Grading or authentication fails for customers: repeated 5xx on one operation,
  or one customer reports a failure that reproduces.
- A release gate fails after deploy and rollback does not restore it.
- A scheduled job that protects data (backup, quota reconcile, usage prune)
  has failed for longer than its window.
- **Any suspected exposure of data or credentials**, however small.

Declaring and then closing as "not an incident" is cheap. Not declaring is how
the 2026-10-17 reboot went ten hours without a severity.

## Severity

| Level | Meaning                                                                                                          | Examples                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| SEV1  | Production is down or wrong for most customers, data is lost, **or a security or privacy exposure is suspected** | Edge probe failing, every grading call 5xx, leaked API key, database credential used from an unknown address |
| SEV2  | One operation, one tier, or one Organization is failing; or a protection is gone with no customer impact yet     | AI Speaking 500s, Sandbox down, backups failing, Vault sealed                                                |
| SEV3  | Degraded with a workaround, or internal only                                                                     | Deploys blocked, slow responses within timeouts, one job late                                                |

A suspected security or privacy exposure is **always SEV1** until it is shown
not to be one. Raise severity freely; lower it only with a reason in the
incident record.

## Checklist

Work top to bottom. Write each step's time into the [incident record](#incident-record).

1. **Declare.** Open a private incident record (see below) and note detection
   time, how it was detected, and a first severity.
2. **Assign one person in charge.** Normally the responder. That person decides;
   everyone else reports to them.
3. **Preserve evidence** if the incident may be a compromise, or if the cause is
   unknown and a restart or redeploy is about to replace a container.
   See [Preserve evidence](#preserve-evidence). Skip only for a known bad release.
4. **Mitigate.**
   - Check the deployed state first: `ops/status.sh` as described in
     [Checking deployed state](deploy-vps.md#checking-deployed-state).
   - Release-caused: pause CD and roll back with the
     [rollback runbook](deploy-vps.md#rollback) (#289).
   - AI Service-caused: confirm provider-independent health and authentication
     first; a provider outage is not a reason to roll back AIHUB. Contact the
     AI Service team.
   - Suspected compromise: use the [containment levers](#containment-levers).
5. **Communicate.** Send the first [customer message](#customer-messages) to the
   affected Organizations within the target for the severity, then update at
   every stage change and at least every 2 hours while SEV1 is open.
6. **Verify recovery at the user boundary.** Not "the container is healthy":
   the edge probe answers, an authenticated grading call returns `200` through
   the public hostname, and the error log lines have stopped (`ops/status.sh`
   `errors=` count). For a customer-reported failure, ask the customer to retry.
7. **Close.** Send the "resolved" message, write the closing time and impact
   into the record, and schedule the postmortem: within 5 working days for
   SEV1 and SEV2, optional for SEV3.

## Preserve evidence

Container logs are deleted with the container, and the containers use
`restart: unless-stopped`, so a crash loop or a deploy destroys evidence on its
own. Before any restart, redeploy, or rollback when a compromise is suspected
or the cause is unknown, do these in order (about 10 minutes):

1. **Pause CD** (`gh workflow disable cd.yml`) so the next merge does not
   replace the containers.
2. **Copy container logs off the host** to the responder's workstation, for
   each affected service (`app`, `app-sandbox`, and the blue-green slot if it is
   active):

   ```sh
   ssh <user>@<host> 'cd <app-dir> && sudo -n docker compose --env-file .env.production -f docker-compose.production.yml logs --no-color --timestamps app' > incident-<date>-app.log
   ```

   Also copy the `deploy-logs/` snapshots from the app directory if the incident
   spans a deploy ([Checking deployed state](deploy-vps.md#checking-deployed-state)).

3. **Record container state:** the output of `ops/status.sh` and
   `docker inspect` for each affected container (start time, restart count,
   image digest).
4. **Disk snapshot** through the VPS provider's control panel, if the
   control-panel holder is reachable and a host compromise is suspected.
5. Store the copies in the private incident folder, never in a GitHub issue,
   chat, or this repository. They contain request IPs and are personal data
   (#287); delete them when the postmortem closes unless legal counsel says
   otherwise.

## Containment levers

For a suspected compromise. Commands run in the environment's app container
through the operator CLI, as the scheduled jobs in
[Scheduled operator jobs](deploy-vps.md#scheduled-operator-jobs) do:
`sudo -n docker compose --env-file .env.production -f docker-compose.production.yml exec -T app node scripts/runtime/runtime-entrypoint.mjs scripts/cli/cli.mjs <command> ...`
(use `--profile sandbox` and `app-sandbox` for Sandbox).

| What leaked or is abused             | Lever                                                                            | Effect and time                                                                                                                | Run against Sandbox |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| One customer API key                 | `key:revoke --key <id> --actor <you>`                                            | Key refused at once; cache entry purged. Audited (ADR-0044)                                                                    | Not recorded        |
| One Organization                     | `org:suspend --org <id> --actor <you>`; undo with `org:restore`                  | Every key of the Organization refused within 60 s; in-flight requests finish. Audited                                          | Not recorded        |
| A reported Writing Task 1 chart      | `writing:chart-revoke --url <public-url> --actor <you>`                          | Origin object deleted; edge result reported separately ([runbook](deploy-vps.md#responding-to-reported-writing-task-1-charts)) | Yes, 2026-10-19     |
| A bad release                        | [Rollback](deploy-vps.md#rollback)                                               | Previous image serving in minutes                                                                                              | Yes (#289)          |
| The whole deployment                 | `sudo -n docker compose ... stop` the active serving slot (and its Sandbox slot) | Every request fails at the edge. Last resort                                                                                   | No                  |
| One AIHUB User Account, its sessions | **Missing** (#367)                                                               | Hand-written SQL only                                                                                                          | No                  |
| One grading operation                | **Missing** (#399)                                                               | Needs a deploy today                                                                                                           | No                  |
| Cached authorisation records         | **Missing** (#349, #348)                                                         | Expire on their TTL                                                                                                            | No                  |
| User Access JWT signing key, JWKS    | **Missing as an emergency path** (#365)                                          | Startup-only rotation                                                                                                          | No                  |
| Runtime secrets (DB, Redis, storage) | **Missing** (#365, #298, #348, #350)                                             | Shared with other applications; rotation needs their owners                                                                    | No                  |
| The production host                  | VPS provider control panel (#381, #58)                                           | Stop or snapshot the VM                                                                                                        | No                  |

Order for a leaked credential: preserve evidence, revoke or suspend, check the
usage records for what the credential did since the leak, then rotate anything
it could have read. The credential inventory is #365; who operates each shared
component is in the [shared infrastructure register](shared-infrastructure.md)
(#362).

## Customer messages

Send from the support mailbox to the owner contact of each affected
Organization. The channel does not depend on the AIHUB host, so it still works
when the host is the problem. Only the incident lead sends them. AIHUB has no
status page; if one is added, it must be hosted off the AIHUB host.

Never include internal identifiers (container, host, commit, database, or
Vault names), stack traces, AI Service response content, or another customer's
name. A customer's own `request_id` values are fine.

**Investigating**

> Subject: [AIHUB] Investigating: <short symptom, e.g. "Speaking grading errors">
>
> Since <time, UTC+7>, some <operation> requests are failing with <status, e.g.
> HTTP 503>. We are investigating. <Whether failed requests count against
> quota, and whether retrying is safe for this operation: check before
> sending.> Next update by <time>.

**Identified**

> Subject: [AIHUB] Identified: <short symptom>
>
> We have found the cause of the <operation> failures that started at <time>
> and are applying a fix. <What the customer should do, or "No action is
> needed.">. Next update by <time>.

**Monitoring**

> Subject: [AIHUB] Monitoring: <short symptom>
>
> A fix was applied at <time>. <operation> requests are succeeding again and we
> are watching to confirm. If you still see failures, reply with the
> `request_id`. Next update by <time>.

**Resolved**

> Subject: [AIHUB] Resolved: <short symptom>
>
> Between <start> and <end> (UTC+7), <what failed, in customer terms>.
> <Was anything charged, lost, or exposed: say so plainly.> The service has been
> working normally since <time>. We will share a summary of the cause and what
> we are changing by <date>.

A suspected personal-data breach changes who decides the wording and the
deadline: record the decision in the incident record and follow #380.

## Incident record

One private document per incident, kept with the evidence copies, not in this
repository. It is the decision log the notification deadline (#380) is counted
from.

```text
Incident: <date> <short name>
Severity: <SEVn>, changes: <time> <from> -> <to> <reason>
Detected: <time UTC> by <alert / customer / person>
Lead: <name>

Timeline (UTC):
<time> <what happened or was decided, by whom>

Personal-data breach? <yes / no / unknown>
  Decided by: <name> at <time>
  Reasoning: <one paragraph>

Notifications:
<time> <recipient: Organization / authority / data subject> <channel> <by whom>

Closed: <time> Impact: <customers, operations, duration, data>
```

## Postmortems

Blameless: describe what the system and the process allowed, not who made a
mistake.

**Where:** `docs/operations/postmortems/<YYYY-MM-DD>-<short-name>.md`, one file
per incident, reviewed like any other change. The repository is public, so a
postmortem names a weakness that is still unfixed as a category with its
issue number, without hosts, addresses, account names, or versions. Details go
in the private incident record. A security incident's postmortem is published
only after its fixes ship.

**Rule:** every follow-up becomes a GitHub issue before the postmortem merges,
and the postmortem links it. A follow-up without an issue is not a follow-up.

Template:

```markdown
# Postmortem: <title>, <date>

Blameless. Times are UTC. Severity: <SEVn>. Incident lead: <role>.

## Summary

<three sentences: what broke, how it was found, how it was fixed>

## Impact

- **Customers:**
- **Releases:**
- **Data:**

## Timeline

| Time (UTC) | Event |
| ---------- | ----- |

## What went wrong

## What went well

## Follow-ups

- #<issue>: <what it changes>

## Gaps found in the incident process
```

Postmortems so far:

- [2026-10-17: shared Vault sealed after the host was powered off](postmortems/2026-10-17-vault-sealed-after-power-off.md)

## Drills

| Drill                                                                                                                                  | Cadence                                         | Owner                              | Next due   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | ---------- |
| Postgres restore rehearsal, both databases (`scripts/ops/backups/restore-postgres-rehearsal.sh`)                                       | Monthly, and after any change to the backup job | The operator who holds the age key | 2026-11-18 |
| Game day: fault scenarios (#328), a rollback (#289), a restore, a reboot drill (#396), compared with the previous run's recovery times | Quarterly                                       | Responder                          | 2027-01-18 |
| Tabletop of this process against a past incident, including one security scenario                                                      | With each game day                              | Responder                          | 2027-01-18 |

A regression in a measured recovery time becomes an issue. The restore
rehearsal cannot run unattended because the age private key is kept off the
host ([Postgres backups](deploy-vps.md#postgres-backups)).

## Tabletop record, 2026-10-19

Walked through on paper, against two scenarios.

**Outage: AI Speaking returns HTTP 500 for one hour (2026-10-04, 55
consecutive errors).** Declare SEV2 (one operation). Preserve evidence: this
step would have kept the logs that were lost with the replaced container.
Mitigate: provider-caused, so no rollback; contact the AI Speaking team.
Communicate: "investigating" to Organizations that called Speaking that hour,
found from the usage records. Verify: an authenticated Speaking call returns
`200`. Gaps: none new; the downstream diagnosis gap is #234 and #235.

**Security: a customer API key is posted publicly, and a database credential is
used from an unknown address.** Declare SEV1. Preserve evidence, then
`key:revoke` the key and read its usage since the leak. The database credential
has no AIHUB-only rotation (#298, #365) and its use from an unknown address
raises no alert (#369). Record the breach decision for #380. Gaps: no backup
responder or escalation path if the responder is unreachable (#830).
