# Capacity benchmark baseline

This is the baseline record that `docs/operations/capacity-benchmark.md` ("When to rerun") compares new runs against. A new baseline replaces this file in the same change that records it. It describes this workload on the recorded GitHub-hosted runner only. It is not an exact capacity claim for the shared 2-vCPU Production host.

## Run

- Recorded 2026-10-21 from the `full` profile, [run 39611997452](https://github.com/AiHub-Ecosystem/aihub-be/actions/runs/39611997452). Its artifacts expire on 2026-11-20; this file is the lasting copy.
- Commit `2e8d1106265192c01197a6cd597610a1ced6b2df`. Its application code matches `main` at `5842e96a`; the commit changes only the benchmark harness.
- Three repetitions ran in parallel, each on its own GitHub-hosted `ubuntu-24.04` VM with 4 vCPUs, 15.6 GiB RAM, and Docker 28.0.4. Repetition 1 ran on an Intel Xeon Platinum 8573C; repetitions 2 and 3 ran on an AMD EPYC 9V45.
- The generator was `grafana/k6:0.54.0`, in its own container on the same VM, outside the AIHUB CPU limit.
- AIHUB was limited to 1.5 CPU and 768 MiB. The stack used `postgres:16-alpine`, `redis:7.4.2-alpine`, and `node:22.23.2-bookworm-slim`.
- Redis RTT was configured at 60 ms. The stub used 2,000 ms latency and a 0 error rate.
- There were 8 synthetic Organizations with `max_concurrent=20`, 256 maximum load VUs, and a minimum of 1,000 samples per grading route.
- Stages ran at 8, 16, 32, and 64 RPS, with an overload stage at 96 RPS. Recovery and scheduled-job contention ran at 8 RPS.

The invalidation inputs at this commit:

- Every value listed above.
- 10 downstream connections per AI Service origin.
- Gateway Redis `commandTimeout` of 200 ms.
- Argon2id `m=65536,t=3,p=1` with a concurrency cap of 2, `UV_THREADPOOL_SIZE=4`, and a queue of 8 with a 1 s wait.

## Results

- **Highest passing mixed-grading rate: 8 RPS** in all three repetitions. Every grading route recorded at least 1,000 samples and 0 errors, with p99 between 2,328 and 2,356 ms.
- **First ceiling: mixed grading at 16 RPS, the downstream connection pool.**
  - The pool has 10 connections per origin. At 2 s per call, each AI Service origin carries about 5 RPS. The 16 RPS stage offers 8 RPS to each origin.
  - Downstream queues peaked at 137 to 142.
  - Writing p99 for accepted requests reached about 30 s.
  - Each run refused 1,256 to 1,277 requests with `429 CONCURRENCY_LIMIT` once Organization permits (8 × 20) filled.
  - Routes completed 971 samples, so the harness records `insufficient_route_samples`.
- **No grading route passes alone, even at 8 RPS.**
  - Writing and Speaking JSON exceed their origin's roughly 5 RPS. Their p99 is about 32 s, with about 90 `429` responses in about 863 samples.
  - Speaking multipart refuses 528 to 529 of 1,000 requests at its per-process upload ceiling of 8, which carries about 3.3 RPS at 2.4 s.
- **Auth.**
  - Refresh and Web Session exchange alone stay at or below 15 ms p99 up to 64 RPS.
  - Login p99 is about 285 ms at 8 RPS. From 16 RPS, the Argon2 cap refuses login with `503 AUTH_ARGON2_CAPACITY`, and login p99 is 1.1 to 1.4 s.
  - At 8 RPS, auth traffic moves grading p99 by under 25 ms.
  - At 64 RPS, auth plus grading takes app CPU to 101 to 106% of its limit.
- **Overload at 96 RPS.**
  - Every refusal is `429 CONCURRENCY_LIMIT`, 3,472 to 3,473 per run.
  - Downstream queues peaked at 125 to 131, and app CPU reached 67 to 100% of its limit.
  - Peak RSS was at most 309 MiB, with no restarts.
  - Recovery at 8 RPS returned 0 errors, with p99 between 2,330 and 2,369 ms.
- **Scheduled jobs.**
  - Quota reconciliation and usage reporting both succeeded in 1.1 to 1.9 s during 8 RPS grading.
  - Grading stayed within its deadlines, and no Postgres pool client waited.
  - App CPU peaked at 77 to 102% of its limit, above the 80% threshold in two of three runs, so the host-wide job lock remains required.
- **Argon2 burst at 16 RPS.**
  - Every contention check passed.
  - Peak RSS was 395 to 406 MiB, under the 614 MiB ADR-0080 gate.
  - During the burst, JWT verify p95 was at most 2.7 ms and DNS lookup p95 at most 3.7 ms.
- **Throughout every stage:**
  - No Postgres pool client waited.
  - Event-loop lag peaked at no more than 0.18 s.
  - There were no restarts and no transport errors.
  - Neither `REDIS_UNAVAILABLE` nor `RETRY_BUDGET_UNAVAILABLE` appeared.
- **Stub limitation.** The stub's Speaking fixture carries no `usage` field, so the usage report flags Speaking as 100% incomplete during the contention stage. This comes from the benchmark, not from Production.

## p99 spread across repetitions

The table below is the run's `repetitions-summary.md`.

| Stage                                           | Route                | Completed samples by repetition | Errors by repetition      | p99 min / median / max (ms)    | Accepted p99 min / median / max (ms) | Sample verdict |
| ----------------------------------------------- | -------------------- | ------------------------------- | ------------------------- | ------------------------------ | ------------------------------------ | -------------- |
| writing_task1 at 8 offered requests/s           | writing_task1        | R1: 863, R2: 864, R3: 863       | R1: 90, R2: 91, R3: 90    | 31836.13 / 32015.19 / 32055.88 | 31838.21 / 32021.45 / 32060.29       | inconclusive   |
| writing_task1 at 16 offered requests/s          | writing_task1        | R1: 892, R2: 893, R3: 893       | R1: 425, R2: 426, R3: 426 | 32065.14 / 32079.74 / 32125.11 | 32119.87 / 32121.81 / 32137.99       | inconclusive   |
| writing_task1 at 32 offered requests/s          | writing_task1        | R1: 953, R2: 954, R3: 952       | R1: 643, R2: 644, R3: 642 | 32140.25 / 32143.59 / 32164.39 | 32165.25 / 32178.59 / 32190.47       | inconclusive   |
| writing_task1 at 64 offered requests/s          | writing_task1        | R1: 1025, R2: 1024, R3: 1025    | R1: 795, R2: 794, R3: 795 | 32152.58 / 32156.47 / 32167.95 | 32163 / 32174.73 / 32198.66          | sufficient     |
| writing_task2 at 8 offered requests/s           | writing_task2        | R1: 864, R2: 864, R3: 863       | R1: 91, R2: 91, R3: 89    | 31788.73 / 31795.35 / 32020.9  | 31792.02 / 31802.85 / 32021.65       | inconclusive   |
| writing_task2 at 16 offered requests/s          | writing_task2        | R1: 893, R2: 893, R3: 893       | R1: 425, R2: 425, R3: 424 | 32066.78 / 32129.41 / 32134.79 | 32135.66 / 32140.65 / 32151.38       | inconclusive   |
| writing_task2 at 32 offered requests/s          | writing_task2        | R1: 953, R2: 951, R3: 953       | R1: 643, R2: 641, R3: 643 | 32141.01 / 32159.66 / 32161.52 | 32156.34 / 32183.33 / 32189.22       | inconclusive   |
| writing_task2 at 64 offered requests/s          | writing_task2        | R1: 1025, R2: 1024, R3: 1025    | R1: 795, R2: 794, R3: 795 | 32163.7 / 32164.48 / 32170.14  | 32174.82 / 32181.09 / 32181.77       | sufficient     |
| speaking_multipart at 8 offered requests/s      | speaking_multipart   | R1: 1001, R2: 1001, R3: 1000    | R1: 529, R2: 528, R3: 528 | 2335.22 / 2338.38 / 2342.48    | 2344.05 / 2357.58 / 2358.65          | sufficient     |
| speaking_multipart at 16 offered requests/s     | speaking_multipart   | R1: 1009, R2: 1009, R3: 1008    | R1: 761, R2: 761, R3: 760 | 2327.7 / 2336.25 / 2338.68     | 2343.07 / 2344.81 / 2352.34          | sufficient     |
| speaking_multipart at 32 offered requests/s     | speaking_multipart   | R1: 1025, R2: 1025, R3: 1025    | R1: 897, R2: 897, R3: 897 | 2322.92 / 2333.27 / 2345.15    | 2327.04 / 2357.24 / 2359.38          | sufficient     |
| speaking_multipart at 64 offered requests/s     | speaking_multipart   | R1: 1025, R2: 1025, R3: 1024    | R1: 961, R2: 961, R3: 960 | 2313.88 / 2330.69 / 2331.65    | 2317.01 / 2358.85 / 2363.43          | sufficient     |
| speaking_json at 8 offered requests/s           | speaking_json        | R1: 864, R2: 864, R3: 864       | R1: 93, R2: 92, R3: 93    | 31824.39 / 31851.31 / 31900.75 | 31834.52 / 31855.89 / 31932.66       | inconclusive   |
| speaking_json at 16 offered requests/s          | speaking_json        | R1: 893, R2: 893, R3: 893       | R1: 427, R2: 425, R3: 427 | 32113.17 / 32144.03 / 32151.46 | 32127.88 / 32163.54 / 32199.54       | inconclusive   |
| speaking_json at 32 offered requests/s          | speaking_json        | R1: 952, R2: 953, R3: 953       | R1: 642, R2: 643, R3: 643 | 32225.31 / 32234.36 / 32385.55 | 32268.52 / 32292.59 / 32413.21       | inconclusive   |
| speaking_json at 64 offered requests/s          | speaking_json        | R1: 1024, R2: 1025, R3: 1025    | R1: 794, R2: 795, R3: 795 | 32330.37 / 32384.71 / 32419.58 | 32366.44 / 32442.34 / 32470.96       | sufficient     |
| mixed_grading at 8 offered requests/s           | writing_task1        | R1: 1000, R2: 1001, R3: 1001    | R1: 0, R2: 0, R3: 0       | 2331.72 / 2345.21 / 2355.58    | 2331.72 / 2345.21 / 2355.58          | sufficient     |
| mixed_grading at 8 offered requests/s           | writing_task2        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2327.62 / 2334.11 / 2348.26    | 2327.62 / 2334.11 / 2348.26          | sufficient     |
| mixed_grading at 8 offered requests/s           | speaking_multipart   | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2335.3 / 2341.23 / 2343.58     | 2335.3 / 2341.23 / 2343.58           | sufficient     |
| mixed_grading at 8 offered requests/s           | speaking_json        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2335.8 / 2345.35 / 2348.46     | 2335.8 / 2345.35 / 2348.46           | sufficient     |
| mixed_grading at 16 offered requests/s          | writing_task1        | R1: 972, R2: 972, R3: 972       | R1: 287, R2: 291, R3: 283 | 29547.56 / 29945.97 / 30062.15 | 29605.25 / 30006.17 / 30100.87       | inconclusive   |
| mixed_grading at 16 offered requests/s          | writing_task2        | R1: 971, R2: 971, R3: 971       | R1: 274, R2: 269, R3: 272 | 29686.9 / 29946.28 / 30152.48  | 29767.43 / 30091.58 / 30200.82       | inconclusive   |
| mixed_grading at 16 offered requests/s          | speaking_multipart   | R1: 971, R2: 971, R3: 971       | R1: 428, R2: 435, R3: 457 | 5647.45 / 5678.59 / 5709.7     | 5672.01 / 5706.09 / 5762.49          | inconclusive   |
| mixed_grading at 16 offered requests/s          | speaking_json        | R1: 971, R2: 971, R3: 971       | R1: 288, R2: 261, R3: 253 | 5800.64 / 5825.2 / 5870.87     | 5804.34 / 5831.8 / 5882.39           | inconclusive   |
| mixed_grading at 32 offered requests/s          | writing_task1        | R1: 982, R2: 981, R3: 983       | R1: 597, R2: 575, R3: 605 | 29352.04 / 29674.03 / 30129.12 | 29691.67 / 29776.57 / 30247.9        | inconclusive   |
| mixed_grading at 32 offered requests/s          | writing_task2        | R1: 982, R2: 981, R3: 982       | R1: 613, R2: 620, R3: 597 | 29610.63 / 29720.73 / 30078.35 | 29776.29 / 29781.14 / 30370.18       | inconclusive   |
| mixed_grading at 32 offered requests/s          | speaking_multipart   | R1: 982, R2: 980, R3: 982       | R1: 755, R2: 751, R3: 737 | 8178.86 / 8348.94 / 8844.02    | 9940.47 / 9954.35 / 10170.36         | inconclusive   |
| mixed_grading at 32 offered requests/s          | speaking_json        | R1: 982, R2: 980, R3: 982       | R1: 577, R2: 594, R3: 599 | 9919.04 / 9944.56 / 10226.07   | 10015.93 / 10049.39 / 10830.87       | inconclusive   |
| mixed_grading at 64 offered requests/s          | writing_task1        | R1: 1008, R2: 1008, R3: 1008    | R1: 783, R2: 784, R3: 797 | 29526.14 / 29627.06 / 29940.8  | 29768.22 / 29853.88 / 30124.28       | sufficient     |
| mixed_grading at 64 offered requests/s          | writing_task2        | R1: 1008, R2: 1008, R3: 1008    | R1: 782, R2: 778, R3: 765 | 29537.4 / 29601.64 / 29987.25  | 29720.76 / 29801.92 / 30136.62       | sufficient     |
| mixed_grading at 64 offered requests/s          | speaking_multipart   | R1: 1008, R2: 1008, R3: 1008    | R1: 900, R2: 900, R3: 913 | 8283.59 / 8294.02 / 8309.61    | 10401.32 / 12054.81 / 12069.08       | sufficient     |
| mixed_grading at 64 offered requests/s          | speaking_json        | R1: 1008, R2: 1008, R3: 1008    | R1: 792, R2: 796, R3: 777 | 11244.85 / 11623.62 / 11726.25 | 12014.23 / 12032.63 / 12038.03       | sufficient     |
| login at 8 offered requests/s                   | login                | R1: 121, R2: 121, R3: 121       | R1: 0, R2: 0, R3: 0       | 282.22 / 284.87 / 443.42       | 282.22 / 284.87 / 443.42             | not_applicable |
| login at 16 offered requests/s                  | login                | R1: 241, R2: 241, R3: 241       | R1: 103, R2: 79, R3: 47   | 1057.73 / 1269.5 / 1394.19     | 1065.66 / 1274.8 / 1412.26           | not_applicable |
| login at 32 offered requests/s                  | login                | R1: 481, R2: 481, R3: 480       | R1: 347, R2: 319, R3: 291 | 1127.91 / 1231.23 / 1376.73    | 1180.2 / 1250.38 / 1408.49           | not_applicable |
| login at 64 offered requests/s                  | login                | R1: 961, R2: 961, R3: 960       | R1: 827, R2: 806, R3: 780 | 1123.5 / 1228.07 / 1387.43     | 1139.39 / 1275.6 / 1438.25           | not_applicable |
| refresh at 8 offered requests/s                 | refresh              | R1: 121, R2: 121, R3: 121       | R1: 0, R2: 0, R3: 0       | 9.43 / 11.39 / 14.42           | 9.43 / 11.39 / 14.42                 | not_applicable |
| refresh at 16 offered requests/s                | refresh              | R1: 241, R2: 241, R3: 240       | R1: 0, R2: 0, R3: 0       | 9.98 / 10.25 / 12              | 9.98 / 10.25 / 12                    | not_applicable |
| refresh at 32 offered requests/s                | refresh              | R1: 480, R2: 481, R3: 481       | R1: 0, R2: 0, R3: 0       | 8.6 / 8.89 / 9.11              | 8.6 / 8.89 / 9.11                    | not_applicable |
| refresh at 64 offered requests/s                | refresh              | R1: 960, R2: 961, R3: 961       | R1: 0, R2: 0, R3: 0       | 8.8 / 8.87 / 10.05             | 8.8 / 8.87 / 10.05                   | not_applicable |
| web_session_exchange at 8 offered requests/s    | web_session_exchange | R1: 120, R2: 121, R3: 120       | R1: 0, R2: 0, R3: 0       | 6.56 / 6.88 / 7.17             | 6.56 / 6.88 / 7.17                   | not_applicable |
| web_session_exchange at 16 offered requests/s   | web_session_exchange | R1: 241, R2: 241, R3: 241       | R1: 0, R2: 0, R3: 0       | 6.34 / 7.85 / 7.93             | 6.34 / 7.85 / 7.93                   | not_applicable |
| web_session_exchange at 32 offered requests/s   | web_session_exchange | R1: 481, R2: 481, R3: 481       | R1: 0, R2: 0, R3: 0       | 5.51 / 5.9 / 7.62              | 5.51 / 5.9 / 7.62                    | not_applicable |
| web_session_exchange at 64 offered requests/s   | web_session_exchange | R1: 961, R2: 961, R3: 961       | R1: 0, R2: 0, R3: 0       | 6.38 / 6.5 / 7.51              | 6.38 / 6.5 / 7.51                    | not_applicable |
| auth_and_grading at 8 offered requests/s        | writing_task1        | R1: 1001, R2: 1001, R3: 1001    | R1: 0, R2: 0, R3: 0       | 2336.23 / 2339.53 / 2368.49    | 2336.23 / 2339.53 / 2368.49          | sufficient     |
| auth_and_grading at 8 offered requests/s        | writing_task2        | R1: 1001, R2: 1001, R3: 1001    | R1: 0, R2: 0, R3: 0       | 2334.27 / 2344.01 / 2346.86    | 2334.27 / 2344.01 / 2346.86          | sufficient     |
| auth_and_grading at 8 offered requests/s        | speaking_multipart   | R1: 1000, R2: 1001, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2340.67 / 2345.9 / 2367.32     | 2340.67 / 2345.9 / 2367.32           | sufficient     |
| auth_and_grading at 8 offered requests/s        | speaking_json        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2342.2 / 2347.6 / 2377.9       | 2342.2 / 2347.6 / 2377.9             | sufficient     |
| auth_and_grading at 8 offered requests/s        | login                | R1: 667, R2: 667, R3: 667       | R1: 0, R2: 0, R3: 0       | 275.37 / 303.44 / 340.13       | 275.37 / 303.44 / 340.13             | not_applicable |
| auth_and_grading at 8 offered requests/s        | refresh              | R1: 334, R2: 334, R3: 334       | R1: 0, R2: 0, R3: 0       | 9.64 / 11.29 / 11.54           | 9.64 / 11.29 / 11.54                 | not_applicable |
| auth_and_grading at 8 offered requests/s        | web_session_exchange | R1: 333, R2: 333, R3: 333       | R1: 0, R2: 0, R3: 0       | 6.76 / 7.1 / 7.8               | 6.76 / 7.1 / 7.8                     | not_applicable |
| auth_and_grading at 16 offered requests/s       | writing_task1        | R1: 981, R2: 981, R3: 981       | R1: 77, R2: 79, R3: 66    | 28900.13 / 29423.88 / 29493.52 | 28904.01 / 29425.49 / 29494.55       | inconclusive   |
| auth_and_grading at 16 offered requests/s       | writing_task2        | R1: 981, R2: 981, R3: 981       | R1: 84, R2: 88, R3: 94    | 28846.9 / 29392.67 / 29418.06  | 28860.97 / 29413.72 / 29418.4        | inconclusive   |
| auth_and_grading at 16 offered requests/s       | speaking_multipart   | R1: 981, R2: 981, R3: 980       | R1: 217, R2: 228, R3: 222 | 3991.76 / 4011.19 / 4013.16    | 3994.39 / 4016.1 / 4019.42           | inconclusive   |
| auth_and_grading at 16 offered requests/s       | speaking_json        | R1: 980, R2: 980, R3: 980       | R1: 93, R2: 67, R3: 76    | 4110.3 / 4111.31 / 4118.6      | 4112.36 / 4114.69 / 4119.05          | inconclusive   |
| auth_and_grading at 16 offered requests/s       | login                | R1: 653, R2: 653, R3: 653       | R1: 0, R2: 0, R3: 0       | 287.08 / 308.75 / 349.42       | 287.08 / 308.75 / 349.42             | not_applicable |
| auth_and_grading at 16 offered requests/s       | refresh              | R1: 327, R2: 327, R3: 327       | R1: 0, R2: 0, R3: 0       | 17.46 / 25.94 / 28.88          | 17.46 / 25.94 / 28.88                | not_applicable |
| auth_and_grading at 16 offered requests/s       | web_session_exchange | R1: 327, R2: 327, R3: 327       | R1: 0, R2: 0, R3: 0       | 7.25 / 9.02 / 13.55            | 7.25 / 9.02 / 13.55                  | not_applicable |
| auth_and_grading at 32 offered requests/s       | writing_task1        | R1: 989, R2: 989, R3: 989       | R1: 515, R2: 504, R3: 505 | 29664.83 / 29847.59 / 30010.48 | 29822.49 / 29855.67 / 30178.02       | inconclusive   |
| auth_and_grading at 32 offered requests/s       | writing_task2        | R1: 989, R2: 989, R3: 989       | R1: 494, R2: 504, R3: 507 | 29817.32 / 29908.96 / 29996.69 | 29901.06 / 29973.23 / 30135.87       | inconclusive   |
| auth_and_grading at 32 offered requests/s       | speaking_multipart   | R1: 988, R2: 988, R3: 989       | R1: 657, R2: 668, R3: 650 | 8167.18 / 8179.07 / 8189.63    | 8578.89 / 8705.44 / 9207.21          | inconclusive   |
| auth_and_grading at 32 offered requests/s       | speaking_json        | R1: 988, R2: 988, R3: 988       | R1: 486, R2: 484, R3: 492 | 9254.61 / 9381.99 / 9418.44    | 9457.73 / 9570.93 / 9642.48          | inconclusive   |
| auth_and_grading at 32 offered requests/s       | login                | R1: 659, R2: 659, R3: 659       | R1: 0, R2: 0, R3: 0       | 280.83 / 348.92 / 441.21       | 280.83 / 348.92 / 441.21             | not_applicable |
| auth_and_grading at 32 offered requests/s       | refresh              | R1: 330, R2: 330, R3: 330       | R1: 0, R2: 0, R3: 0       | 16.87 / 32.92 / 40.3           | 16.87 / 32.92 / 40.3                 | not_applicable |
| auth_and_grading at 32 offered requests/s       | web_session_exchange | R1: 329, R2: 329, R3: 329       | R1: 0, R2: 0, R3: 0       | 13.76 / 15 / 34.07             | 13.76 / 15 / 34.07                   | not_applicable |
| auth_and_grading at 64 offered requests/s       | writing_task1        | R1: 1007, R2: 1009, R3: 1009    | R1: 728, R2: 737, R3: 726 | 29555.65 / 29807.61 / 29936.71 | 29864.56 / 29958.09 / 30184.97       | sufficient     |
| auth_and_grading at 64 offered requests/s       | writing_task2        | R1: 1006, R2: 1008, R3: 1008    | R1: 736, R2: 727, R3: 737 | 29367.84 / 29839.27 / 29883.6  | 29757.78 / 29994.45 / 30072.73       | sufficient     |
| auth_and_grading at 64 offered requests/s       | speaking_multipart   | R1: 1006, R2: 1008, R3: 1008    | R1: 860, R2: 866, R3: 867 | 8494 / 8705.83 / 8870.39       | 10395.16 / 10540.36 / 11001.44       | sufficient     |
| auth_and_grading at 64 offered requests/s       | speaking_json        | R1: 1006, R2: 1008, R3: 1008    | R1: 735, R2: 725, R3: 723 | 11542.34 / 11757.86 / 11893.46 | 11780.71 / 11918.59 / 12137.82       | sufficient     |
| auth_and_grading at 64 offered requests/s       | login                | R1: 671, R2: 672, R3: 672       | R1: 177, R2: 0, R3: 0     | 378.19 / 593.15 / 1810.43      | 378.19 / 593.15 / 1826.44            | not_applicable |
| auth_and_grading at 64 offered requests/s       | refresh              | R1: 335, R2: 336, R3: 336       | R1: 0, R2: 0, R3: 0       | 38.07 / 78.42 / 383.2          | 38.07 / 78.42 / 383.2                | not_applicable |
| auth_and_grading at 64 offered requests/s       | web_session_exchange | R1: 335, R2: 336, R3: 336       | R1: 0, R2: 0, R3: 0       | 40.44 / 67.02 / 312.66         | 40.44 / 67.02 / 312.66               | not_applicable |
| Argon2 login burst at 16 requests/s             | login                | R1: 240, R2: 241, R3: 240       | R1: 119, R2: 85, R3: 49   | 1042.46 / 1264.17 / 1508.62    | 1045.31 / 1266.68 / 1512.82          | not_applicable |
| mixed_grading overload at 96 offered requests/s | writing_task1        | R1: 1009, R2: 1009, R3: 1008    | R1: 836, R2: 835, R3: 842 | 26337.72 / 27855.69 / 28088.04 | 27833.05 / 28088.2 / 29298.35        | sufficient     |
| mixed_grading overload at 96 offered requests/s | writing_task2        | R1: 1008, R2: 1008, R3: 1008    | R1: 837, R2: 846, R3: 834 | 26257.8 / 27927.63 / 28072.54  | 27811.17 / 28080.15 / 28686.55       | sufficient     |
| mixed_grading overload at 96 offered requests/s | speaking_multipart   | R1: 1008, R2: 1008, R3: 1008    | R1: 957, R2: 958, R3: 956 | 10111.33 / 10150.95 / 10363.71 | 12113.09 / 12182.25 / 12226.69       | sufficient     |
| mixed_grading overload at 96 offered requests/s | speaking_json        | R1: 1008, R2: 1008, R3: 1008    | R1: 843, R2: 834, R3: 840 | 11814.92 / 12008.39 / 12200.92 | 12103.72 / 12168.76 / 12886.77       | sufficient     |
| post-overload recovery at 8 requests/s          | writing_task1        | R1: 1000, R2: 1001, R3: 1001    | R1: 0, R2: 0, R3: 0       | 2338.62 / 2343.59 / 2346.53    | 2338.62 / 2343.59 / 2346.53          | sufficient     |
| post-overload recovery at 8 requests/s          | writing_task2        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2330.01 / 2335.74 / 2343.45    | 2330.01 / 2335.74 / 2343.45          | sufficient     |
| post-overload recovery at 8 requests/s          | speaking_multipart   | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2342.3 / 2344.77 / 2355.24     | 2342.3 / 2344.77 / 2355.24           | sufficient     |
| post-overload recovery at 8 requests/s          | speaking_json        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2338.88 / 2349.75 / 2369.48    | 2338.88 / 2349.75 / 2369.48          | sufficient     |
| scheduled-job contention at 8 requests/s        | writing_task1        | R1: 1001, R2: 1001, R3: 1001    | R1: 0, R2: 0, R3: 0       | 2342.65 / 2349.12 / 2353.66    | 2342.65 / 2349.12 / 2353.66          | sufficient     |
| scheduled-job contention at 8 requests/s        | writing_task2        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2338.31 / 2345.25 / 2360.79    | 2338.31 / 2345.25 / 2360.79          | sufficient     |
| scheduled-job contention at 8 requests/s        | speaking_multipart   | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2334 / 2342.98 / 2368.49       | 2334 / 2342.98 / 2368.49             | sufficient     |
| scheduled-job contention at 8 requests/s        | speaking_json        | R1: 1000, R2: 1000, R3: 1000    | R1: 0, R2: 0, R3: 0       | 2344.74 / 2347.48 / 2356.39    | 2344.74 / 2347.48 / 2356.39          | sufficient     |

Each stage verdict is inconclusive if it is missing a repetition or any grading route has fewer than the configured minimum samples. The sample verdict counts every response, so read it with the error column: a route that answers only with errors has enough samples but no capacity. Accepted p99 covers 2xx responses only.
