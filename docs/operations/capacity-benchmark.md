# Capacity benchmark

Run the repeatable gateway capacity benchmark from a local checkout:

```sh
pnpm capacity:benchmark
```

The runner requires a clean Git checkout so the Docker image matches the commit
recorded in the report. It snapshots the k6 harness and its utility module into
the run artifact so every stage uses the same source. The report records the
resolved image ID and repository digest for every Compose image.

It starts a uniquely named Docker Compose project with a disposable Postgres
volume, Redis, the AIHUB container, a controlled AI Service stub, and a pinned
`grafana/k6:0.54.0` runner. The benchmark network is internal to Docker and has
no published ports. It does not call Production, Sandbox, AI Writing, AI
Speaking, Resend, or SeaweedFS. `docker compose down --volumes` removes only the
temporary project and its benchmark data volume after the run.

The AIHUB target is limited to 1.5 CPU and 768 MiB. The seed creates eight
synthetic Organizations with `max_concurrent=20`, 100,000 synthetic usage rows,
and one pre-verified MFA-disabled user per configured load VU plus one metrics
VU (257 users at the default 256 load VUs). Passwords use the current Argon2id
profile (`m=65536,t=3,p=1`). No registration, email, MFA, or outbound provider
call is part of the run. API keys, session tokens, and passwords are created
inside the temporary Docker volume and are removed when Compose tears the
project down.

The stub returns the checked-in AI Writing Task 1 and Task 2 response fixtures
and the checked-in AI Speaking response fixture for both Speaking transports.
Its fixed delay and deterministic error rate are configurable. It serves AI
Writing on port 8080 and AI Speaking on port 8081, because Production reaches
the two services at separate origins and the gateway keeps one 10-connection
pool per origin; one shared stub origin would halve that ceiling. A local TCP
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
The default rate stages are 4, 8, 16, and 32 requests per second. The base
hold duration is 15 seconds, but grading stages are lengthened to collect at
least 1,000 responses for every grading route in that stage. The report marks
any route below that minimum as inconclusive and excludes the stage from its
highest passing rate. Mixed grading gives each route one quarter of the offered
rate. The auth-and-grading schedule gives each grading route 3/16 of the
offered rate. Auth-only stages keep the configured base duration.
The auth-and-grading schedule places one auth request in every four-request
block. k6 allows each load iteration up to 65 seconds after the arrival window
to finish, matching the longest 60-second operation deadline plus a five-second
margin.
After those measurements, the runner selects one mixed grading overload stage
above the highest configured rate. It then holds the mixed profile at the
highest measured passing rate long enough to collect the minimum samples and
confirm recovery after offered load drops. If no mixed stage passes, recovery
and scheduled-job contention are skipped and marked unavailable in the report.
The stage rates and base hold duration can be changed with
`BENCHMARK_STAGE_RATES_RPS` and `BENCHMARK_DURATION`. The per-route sample
minimum uses `BENCHMARK_MINIMUM_GRADING_SAMPLES`. Redis RTT, stub latency, stub
error rate, and maximum VUs use `BENCHMARK_REDIS_RTT_MS`,
`BENCHMARK_STUB_LATENCY_MS`, `BENCHMARK_STUB_ERROR_RATE`, and
`BENCHMARK_MAX_VUS`.

The `Capacity benchmark` GitHub Actions workflow runs only through
`workflow_dispatch`. It runs three repetitions at 8, 16, 32, and 64 offered
requests per second on a fresh `ubuntu-24.04` GitHub-hosted VM, with the same 1,000
sample minimum, 60 ms Redis RTT, and 2,000 ms stub latency. It is not a pull
request gate. The workflow records the runner hardware and Docker engine,
uploads each raw JSON result, and includes the p99 min/median/max spread across
repetitions in the Actions summary and artifact. Its runner is 4-vCPU; record
that shape when comparing the measured 1.5-CPU AIHUB container with the shared
2-vCPU Production host. The result is not an exact Production capacity claim.

During each stage, k6 scrapes `/metrics` once per second. The report includes
offered and completed rates (completed rate uses the configured hold interval),
route p50/p95/p99, response shares, and per-route error counts,
error counts by HTTP status and AIHUB error code (`errorsByCode`, read from the
gateway's request completion log), transport errors that never reached the
gateway, p50/p95/p99 for accepted (2xx) responses alone so a fast refusal
cannot improve a percentile, injected stub failures, process RSS and heap,
event-loop lag, Postgres pool
waiting clients, downstream queue counts, and the corrected grading
`total_ms`, `admission_ms`, and `downstream_ms`. It also records Docker CPU and
memory samples for AIHUB and host CPU and memory observations. The p99 targets
are the operation deadlines in `src/catalog/operation-catalog.ts`. For the
scheduled-job overlap run, the explicit thresholds are p99 within those
deadlines, app CPU and memory below 80% of their configured limits, host CPU
below 80%, host memory use below 80%, and zero Postgres pool waiting clients.
These are local benchmark operating thresholds that leave headroom; they do
not establish Production tenant capacity.

The report also includes admission and post-result completion p50/p95/p99 by
the observed `identity_mode` and `retry_budget` pair, plus the sample count for
each pair. Route and observed-path sample counts below the configured minimum
make the stage inconclusive. A run reports only the paths it exercised; use an
active identity configuration and keyed Writing requests to measure the signed
assertion and retry-budget paths.

At the highest mixed-grading rate that met all four p99 deadlines and delivered
its full offered load, the harness runs quota reconciliation and usage
reporting concurrently in the disposable stack while grading continues. This
exercises the highest-risk job pair. The Production host wrapper serializes different
scheduled jobs under its host-wide lock; `scripts/ops/host-jobs/host-scheduled-job.spec.sh`
checks that a competing job is logged as deferred while the lock is held. The
report records route-specific latency, errors, queue/resource peaks, restart
count, job outcomes, and the recovery stage after offered load drops. The runner
starts the jobs after k6 reports its first load iteration and fails the
contention check if either takes longer than 27 seconds, leaving a three-second
margin within the 30-second job-completion budget. Grading continues until the
sample minimum is reached. The seed provides at least one
refresh-token user per configured
maximum load VU plus the metrics scenario VU. The runner rejects settings above
512 load VUs, and k6 checks the full credential pool before sending requests.

The final stage runs a login burst intended to saturate the per-process Argon2
cap (defaults: 16 requests/s with a cap of two and `UV_THREADPOOL_SIZE=4`); it
fails unless the burst records an actual queue wait. An in-process
probe measures `dns.lookup('benchmark-support')` and RS256 `jose.jwtVerify`
every 100 ms during an idle window and the burst. The idle window starts only
after every downstream pool queue left by the preceding stages has drained
(the run fails if they are still queued after two minutes). It lasts five
seconds and extends in five-second steps, up to 30 seconds, until it has ten
samples of each probe. When the probe
observes Argon2 queue work, it runs one image through the production Writing
chart sanitizer and its serialized processing queue, tying the chart
verification to actual hash contention. The report records login
p50/p95/p99 and errors, probe p95s, the chart verification result, and peak
process RSS; the run fails if a probe sample is missing, chart verification
does not complete, or RSS exceeds ADR-0080's 614 MiB gate. The report includes
the probe source and a snapshot of its script. Override the Argon2 settings
with `BENCHMARK_ARGON2_MAX_CONCURRENCY`,
`BENCHMARK_ARGON2_THREADPOOL_SIZE`, and `BENCHMARK_ARGON2_BURST_RATE_RPS`.

Each JSON result is written to the ignored
`artifacts/capacity-benchmark/<run-id>/results.json`. A run that fails, or
whose Argon2 contention checks do not all pass, writes its completed stages and
the error to `partial-results.json` instead, so a late failure still leaves
evidence; it never counts as a repetition. The GitHub workflow also
writes `repetitions-summary.json` and `repetitions-summary.md` beside those run
directories. Keep the environment, commit, rate schedule, workload mix, and
host details with any baseline shared with issues #268, #273, #328, #398, or
#224 (#114 is closed and superseded). A result describes only this workload
and its recorded runner; it is not an exact capacity claim for the shared
2-vCPU Production host.

## When to rerun

The benchmark has no schedule. It is rerun by hand, with the `Capacity
benchmark` workflow's `full` profile, whenever one of the invalidation triggers
below fires. A scheduled run that nobody compares costs runner time and teaches
nothing. Each trigger names a recorded input of the baseline, so a fired
trigger is exactly the case where the recorded numbers stop describing the
code. Do not add a `schedule:` until #713 bounds every Docker, k6, and probe
child and always tears the stack down. Without that, an unattended hung run
burns the 300-minute job limit and leaves a stack on the runner.

Invalidation triggers:

- The runner image (`ubuntu-24.04`) or the pinned generator
  (`grafana/k6:0.54.0`) changes. Keep the benchmark pinned even where
  `ci.yml` uses `ubuntu-latest`; the pin keeps repetitions comparable.
- A Compose image changes: `postgres:16-alpine`, `redis:7.4.2-alpine`, or
  `node:22.23.2-bookworm-slim`.
- The AIHUB container limits change (1.5 CPU, 768 MiB), or ADR-0080's 614 MiB
  RSS gate changes.
- A declared constant changes: `BENCHMARK_REDIS_RTT_MS` (60),
  `BENCHMARK_STUB_LATENCY_MS` (2000), `BENCHMARK_MAX_VUS` (256), or the 1,000
  sample minimum.
- Code behind a measured ceiling changes: the downstream connection pool, the
  grading admission chain (rate limit, quota, concurrency, retry budget), or the
  Argon2 profile and its concurrency cap.
- The Production host topology changes. The first question of the review checklist in
  `docs/reliability-maturity.md` section D asks this against the topology in
  section C: host size, slot count, a new shared dependency, a pool or
  `connection_limit`, or a pooler.

Whoever lands the change that fires a trigger dispatches the run. They compare
its `repetitions-summary.md` with the baseline record in this document before
the triggering issue closes. Do not compare it with memory or an expired
artifact; the workflow keeps artifacts for 30 days. A new baseline replaces the
record here in the same change, together with the commit and the triggers that
were true at that commit.

A rerun is a regression, and opens a follow-up issue, when any of these is
true:

- For any stage and grading route, the median p99 across three repetitions
  exceeds the recorded baseline's maximum p99 for that stage and route.
- A route that had enough samples in the baseline is now inconclusive.
- The highest passing mixed-grading rate drops, or the first observed ceiling
  changes.

The follow-up issue links the run and is posted to the baseline's consumers:
#268, #273, #328, and #398.
