# ADR-0162: Edge probe failure tolerance and duration recording in blue-green cutover

- Status: Accepted
- Date: 2026-11-11
- Amends: [ADR-0085](0085-per-tier-blue-green-cutover.md) (single-failure rollback rule)
- Related: [#710](https://github.com/AiHub-Ecosystem/aihub-be/issues/710), [#114](https://github.com/AiHub-Ecosystem/aihub-be/issues/114), [#113](https://github.com/AiHub-Ecosystem/aihub-be/issues/113), [ADR-0085](0085-per-tier-blue-green-cutover.md)

## Context

ADR-0085 originally specified that no public `/health` probe may fail during deployment. In practice on the two-vCPU production host, CD runs 38842475545 and 38883548642 experienced false rollbacks of healthy releases due to transient probe timeouts:

- During image extraction (~40 seconds into the pull), two consecutive samples timed out at the 4-second curl limit (`000request_error`), triggering rollback of an otherwise healthy release that passed on retry.
- During database migrations, another release failed and rolled back when Sandbox timed out for two samples while PostgreSQL and migration jobs contended for CPU and disk I/O.

Empirical sample analysis by deployment phase on the 2-vCPU host showed:

| Phase                   | Sample Count (Typical) | Fraction Exceeding 4s        | Primary Cause                                  |
| ----------------------- | ---------------------- | ---------------------------- | ---------------------------------------------- |
| Image extraction / pull | 40–60                  | ~2–3% (1–2 transient spikes) | Host CPU/IO contention during decompression    |
| Database migration      | 15–30                  | ~3–5% (1–2 transient spikes) | Shared PostgreSQL lock/disk contention on host |
| Candidate start / drain | 20–40                  | <1%                          | Temporary scheduler jitter                     |
| Final window / idle     | 10–15                  | 0%                           | Uncontended edge                               |
| Actual edge outage      | Continuous             | 100%                         | Nginx upstream down or container crash         |

Previously, `edge-probes.tsv` recorded only start timestamp, end timestamp, tier, and status. Durations had to be inferred from timestamp differences across log lines, and phases were untracked. Furthermore, `failed_edge_tiers` considered any single non-2xx sample a fatal tier failure, and when no failures existed, unconditionally re-probed active tiers.

## Decision

1. **Per-sample duration and phase recording:** Update `probe_host` in `scripts/ops/blue-green/blue-green-host.sh` to capture exact curl total elapsed time (`%{time_total}`) and the active deploy phase (`pull`, `migration`, `candidate-start`, `drain`, `cutover-smoke`, `final-window`, or `fallback`). Append 6 tab-separated columns (`started_at`, `ended_at`, `tier`, `status`, `duration`, `phase`) to `edge-probes.tsv`.

2. **Tolerate transient probe blips with consecutive failure threshold:** Replace the single-sample failure rule in `failed_edge_tiers` with a threshold of 3 consecutive non-2xx probe failures (configurable via `EDGE_MONITOR_FAILURE_THRESHOLD`, defaulting to 3). Isolated 1- or 2-sample timeouts caused by host contention no longer mark a tier failed. Sustained outages (3 or more consecutive failures, or a failed fallback probe when no samples were captured for an active tier) continue to mark the tier failed and trigger rollback.

3. **Consistent window evaluation:** Update `probe_window` to assess overall window health via `failed_edge_tiers`, preventing individual process exit codes from falsely failing verification windows when transient single-probe timeouts occur.

## Consequences

- Healthy releases deployed during heavy image decompression or database migration no longer suffer false-positive rollbacks.
- Real edge outages (3+ consecutive probe failures or continuous downtime) remain guaranteed to fail deployments and trigger blue-green rollback.
- `edge-probes.tsv` contains durable per-sample latency and phase attribution, enabling direct analysis for future capacity tuning without parsing log timestamps.
