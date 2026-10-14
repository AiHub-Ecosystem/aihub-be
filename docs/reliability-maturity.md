# AIHUB Reliability Maturity Rubric

**Purpose.** A repeatable lens for reviewing AIHUB as a production system. Run it at each
production review, release gate, or after a significant incident, and record where AIHUB
stands against two canonical references:

- **AWS Well-Architected Framework — Reliability Pillar** (design principles + review areas).
- **Google Site Reliability Engineering** (SLOs / error budgets, the four golden signals,
  cascading-failure control, testing for recovery, incident management).

**How to use.** For each row below, decide the current verdict, cite the artifact that backs
it (an ADR, an issue, or code), and if the verdict is 🟡 or 🔴, name the owner or record the
decision to defer. Verdicts and the baseline table are a **dated snapshot** (2026-10-14) —
issue states change, so re-verify each referenced issue before trusting this file's verdicts.

Legend: 🟢 principle is satisfied by tracked, implemented work · 🟡 partially met, or met by a
decision that is still open · 🔴 not met, no owner.

References:

- Reliability Pillar design principles — https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/design-principles.html
- SLOs — https://sre.google/sre-book/service-level-objectives/
- Monitoring / four golden signals — https://sre.google/sre-book/monitoring-distributed-systems/
- Addressing cascading failures — https://sre.google/sre-book/addressing-cascading-failures/

---

## A. AWS Reliability Pillar — design principles

| Principle                                 | What good looks like                                                            | AIHUB evidence                                                                                                                                                                                                               | Verdict                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Run systems as code**                   | Infra, config, and schema changes are versioned and reproducible                | Compose files; migrations with checksums #283; CI publishes the image it booted (ADR-0064); managed nginx in-repo (ADR-0079)                                                                                                 | 🟢 (external shared services sized by another team → #298 / #348)                                |
| **Automate to anticipate failure**        | Detection and remediation are automatic, not human-triggered                    | Breakers #199; auto-restart + alert on OOM/crash-loop #396; cache-fallback #402; retry policy #332; load-shed on recovery #631                                                                                               | 🟢                                                                                               |
| **Scale horizontally**                    | Replace one large resource with many small ones so no single instance is fatal  | blue-green `app` + `app-slot-b` is a **deploy** mechanism, not throughput; no `replicas:`/autoscaling; one VPS (2 vCPU / 8 GB / no swap), single external Postgres / Redis / nginx                                           | 🔴 — the engineering path has no owner; the question lives in the **#657** availability decision |
| **Manage capacity / variance**            | Capacity is measured to a ceiling, not guessed; hard limits sized with headroom | #327 measures per-process ceilings; #560 sizes the shared Postgres connection budget × deploy slots; #270 caps in-flight 25 MiB audio; #640 storage writability; #588 / #642 bulkheads                                       | 🟢 (variance _governance_ = error budget → §B, 🔴)                                               |
| **Do not change too many things at once** | Progressive delivery; each change is small and reversible                       | ADR-0085 per-tier blue-green; canaries #397 / #458; migration rehearsed on a restored copy #400; CI blocks unintended API breaks #473                                                                                        | 🟢                                                                                               |
| **Diversify common dependencies**         | Do not put critical function behind one instance/provider                       | Everything shares one VPS; Redis on a shared Wispace instance #348; Postgres shared #298; single email vendor (Resend #230 / #449 / #635), single payment rail (PayOS #506 / #507), single AI provider per skill #397 / #458 | 🔴/🟡 — isolate-for-security is tracked, single-**vendor** diversity is undecided → **#657**     |
| **Relax availability requirements**       | Match availability effort to the real user-facing requirement per route         | #454 sets an RTO for host-rebuild; per-route availability objectives not yet stated                                                                                                                                          | 🟡 — resolved when **#657** answers the objective                                                |

---

## B. Google SRE — core practices

| Practice                                                       | What good looks like                                                                                | AIHUB evidence                                                                                                                                 | Verdict                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SLI / SLO / error budget**                                   | A target per critical journey, an error budget derived from it, and a stated consequence when spent | #472 latency budget (auth + admission); #634 per-operation p95 CI gate; #373 retryable-vs-refusal shape                                        | 🔴 — AIHUB has reliability _measurements_ but no reliability _policy_ (no error-budget artifact). In-or-out-of-scope decided in **#657**                                                                                                                     |
| **Four golden signals** (latency, traffic, errors, saturation) | Every critical journey alerts across all four, with **saturation as the leading signal**            | Latency #634; errors #373 / #451 / canary #397 / #458; tracing #63; log/request correlation #93; alert catalog + per-alert runbook #412        | 🟡 — **saturation** (CPU/heap against `cpus:1.5`/`768m`, `UV_THREADPOOL_SIZE=4` queue, Postgres connection budget, audio in-flight, downstream permits) is measured in tests but not a live leading-indicator alert → coverage requirement added on **#412** |
| **Cascading-failure control**                                  | Load shedding, retry throttling, per-request deadlines, admission control                           | #631 shed-on-recovery; #632 cross-layer retry budget; #633 request-deadline propagation; #372 degraded-mode matrix                             | 🟢                                                                                                                                                                                                                                                           |
| **Test for recovery**                                          | Failure paths and restores are rehearsed, not assumed                                               | Fault injection #328; restore drill #400; host-rebuild runbook #454; saga forward-recovery #407; real-infra E2E #605                           | 🟢                                                                                                                                                                                                                                                           |
| **Incident management**                                        | Defined severity, on-call, runbook, communication, and blameless postmortem                         | Per-alert runbook/owner/severity + watchdog for the alerting path #412; security incident response + customer communication + postmortems #293 | 🟡 — response and a security IR process exist; a general on-call rotation and blameless-postmortem cadence are not a tracked artifact                                                                                                                        |
| **Eliminate toil**                                             | Repetitive manual ops are automated                                                                 | Compose + scripts under `ops/` and `scripts/ops/`; blue-green cutover; scheduled retention/prune sweeps                                        | 🟢                                                                                                                                                                                                                                                           |

---

## C. Baseline snapshot — 2026-10-14

Measured topology that bounds every verdict above (re-read `docker-compose.production.yml` at each review):

- Host: **2 vCPU / 8 GB / no swap**; app slots `cpus: 1.5`, `mem_limit: 768m`, `pids_limit: 150`, `/tmp` tmpfs 64m.
- `app` + `app-slot-b` (blue-green profile) — **deploy** slots, not throughput replicas.
- Shared Postgres `max_connections = 100` across four applications; **no PgBouncer**, no explicit `connection_limit`; `UV_THREADPOOL_SIZE` unset (default 4).
- Postgres, Redis, Vault server, nginx, SeaweedFS are all **external single instances**; Redis is shared with other Wispace apps.
- Speaking multipart grading holds **25 MiB** per in-flight request in process memory.

Strongest areas (🟢): automate-to-anticipate-failure, progressive change, recovery testing,
cascading-failure control, run-systems-as-code.

Genuine soft spots (🔴), both **decision-gated on #657**, deliberately not filed as build work:

1. **Scale horizontally** — no path from "one shared VPS" to "more than one box".
2. **Error budget / SLO policy** — measurements exist, governing policy does not (defensible to defer pre-launch, but the deferral should be recorded, not silent).

Adjacent 🟡 to keep in view: saturation-as-live-signal (**#412**), single-vendor dependency
diversity (**#657**), and a general on-call / blameless-postmortem process (**#293** is
security-scoped; a broader one is not tracked).

---

## D. Review checklist (answer each when you run this)

- [ ] For each §A principle and §B practice, is the verdict still correct against the **current** tracker, or has an issue moved state?
- [ ] Has the measured topology (§C) changed — host size, slot count, a new shared dependency, a pool or `connection_limit` set, a PgBouncer added?
- [ ] Are #657's open decisions (availability objective, RPO for durable rows, scale trigger, single-vendor stance, error-budget scope) answered? If yes, this rubric's 🔴 rows should have moved.
- [ ] Does the #412 alert catalog now declare coverage across all four golden signals, with a saturation leading-indicator per shared ceiling?
- [ ] Did any incident expose a principle we marked 🟢 that in practice failed? Re-score it honestly.

**Refresh cadence:** re-run at every production review and after any sev-1/sev-2 incident;
update the §C baseline and the dated verdicts, and link the review to the relevant issues.
