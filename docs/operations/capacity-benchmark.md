# Capacity benchmark

Run the repeatable gateway capacity benchmark from a local checkout:

```sh
pnpm capacity:benchmark
```

The runner requires a clean Git checkout so the Docker image matches the commit
recorded in the report.

It starts a uniquely named Docker Compose project with a disposable Postgres
volume, Redis, the AIHUB container, a controlled AI Service stub, and a pinned
`grafana/k6:0.54.0` runner. The benchmark network is internal to Docker and has
no published ports. It does not call Production, Sandbox, AI Writing, AI
Speaking, Resend, or SeaweedFS. `docker compose down --volumes` removes only the
temporary project and its benchmark data volume after the run.

The AIHUB target is limited to 1.5 CPU and 768 MiB. The seed creates four
synthetic Organizations with `max_concurrent=20`, 512 pre-verified
MFA-disabled users, and synthetic usage rows for the operator jobs. Passwords
use the current Argon2id profile (`m=65536,t=3,p=1`). No registration, email,
MFA, or outbound provider call is part of the run. API keys, session tokens,
and passwords are created inside the temporary Docker volume and are removed
when Compose tears the project down.

The stub returns the checked-in AI Writing Task 1 and Task 2 response fixtures
and the checked-in AI Speaking response fixture for both Speaking transports.
Its fixed delay and deterministic error rate are configurable. A local TCP
proxy adds 30 ms in each direction to Redis by default, for a configured 60 ms
round trip. The report records the configured RTT; it is not a one-way delay.

The default run measures each grading route alone, then a 50:50 Writing and
Speaking mix split evenly across the four routes. Before each refresh-containing
stage, the harness restores synthetic refresh-token state so rotation from a
prior stage cannot turn later requests into reuse failures. It then measures
password login, refresh, and Web Session exchange alone, then mixes those auth
routes with grading in an interleaved 75:25 target schedule. The report records
each route's share of returned API responses for every stage, including a stage
that ends partway through the 16-request cycle. Within each full cycle, login
is 50% of auth requests, refresh 25%, and Web Session exchange 25%.
Each rate stage holds for 15 seconds at 4, 8, 16, and 32 requests per second.
The auth-and-grading schedule places one auth request in every four-request
block. k6 allows each load iteration up to 65 seconds after the arrival window
to finish, matching the longest 60-second operation deadline plus a five-second
margin.
After those measurements, the runner selects one mixed grading overload stage above the
highest stage where all four grading p99 values met their operation deadlines.
It then holds the mixed profile for 30 seconds at the selected passing rate to
confirm recovery after offered load drops.
The stage rates and hold duration can be changed with
`BENCHMARK_STAGE_RATES_RPS` and `BENCHMARK_DURATION`; Redis RTT, stub latency,
stub error rate, and maximum VUs use `BENCHMARK_REDIS_RTT_MS`,
`BENCHMARK_STUB_LATENCY_MS`, `BENCHMARK_STUB_ERROR_RATE`, and
`BENCHMARK_MAX_VUS`.

During each stage, k6 scrapes `/metrics` once per second. The report includes
offered and completed rates (completed rate uses the configured hold interval),
route p50/p95/p99, response shares, and per-route error counts,
injected stub failures, process RSS and heap, event-loop lag, Postgres pool
waiting clients, downstream queue counts, and the corrected grading
`total_ms`, `admission_ms`, and `downstream_ms`. It also records Docker CPU and
memory samples for AIHUB and host CPU and memory observations. The p99 targets
are the operation deadlines in `src/catalog/operation-catalog.ts`. For the
scheduled-job overlap run, the explicit thresholds are p99 within those
deadlines, app CPU and memory below 80% of their configured limits, host CPU
below 80%, host memory use below 80%, and zero Postgres pool waiting clients.
These are local benchmark operating thresholds that leave headroom; they do
not establish Production tenant capacity.

At the highest mixed-grading rate that met all four p99 deadlines and delivered
its full offered load, the harness runs quota reconciliation and usage
reporting concurrently in the disposable stack while grading continues. This
exercises the highest-risk job pair. The Production host wrapper serializes different
scheduled jobs under its host-wide lock; `scripts/ops/host-scheduled-job.spec.sh`
checks that a competing job is logged as deferred while the lock is held. The
report records route-specific latency, errors, queue/resource peaks, restart
count, job outcomes, and the recovery stage after offered load drops.

The JSON result is written to the ignored
`artifacts/capacity-benchmark/<run-id>/results.json`. Keep the environment,
commit, rate schedule, workload mix, and host details with any baseline shared
with issues #268, #273, #328, #398, or #114. A local result describes only this
workload and Docker host; it is not an exact capacity claim for the shared
2-vCPU Production host.
