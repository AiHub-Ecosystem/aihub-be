# PostgreSQL query-plan and growth baseline

Generated: 2026-10-21T02:46:50.861Z
Source revision: d3dc8a98 (working tree had local changes)
Database: local disposable PostgreSQL 16.15; this is synthetic data, not a production rate limit.
Seed: 100 Organizations, 100,000 API keys, 100,000 memberships, 1,000,000 usage records, 100,000 idempotency records, 100,000 dispatch attempts, and 100,000 Sandbox reservations.
Retention cutoff: 30 days; timestamps span 210 days; batch size: 500.
pg_stat_statements: not installed in this disposable database.

## Relation sizes

| Table                           |      Rows | Heap/table |   Indexes |     Total | created_at correlation |
| ------------------------------- | --------: | ---------: | --------: | --------: | ---------------------: |
| `organizations`                 |       100 |   56.0 KiB |  24.0 KiB |  80.0 KiB |                  1.000 |
| `api_keys`                      |   100,000 |   19.6 MiB |  10.3 MiB |  29.9 MiB |                  1.000 |
| `user_accounts`                 |     1,000 |  136.0 KiB | 112.0 KiB | 248.0 KiB |                  1.000 |
| `organization_members`          |   100,000 |   10.5 MiB |   7.3 MiB |  17.8 MiB |                  1.000 |
| `idempotency_records`           |   100,000 |   20.6 MiB |  15.0 MiB |  35.6 MiB |                  1.000 |
| `sandbox_allowance_defaults`    |         2 |    8.0 KiB |  16.0 KiB |  24.0 KiB |                      — |
| `sandbox_allowance_overrides`   |         1 |   16.0 KiB |  16.0 KiB |  32.0 KiB |                      — |
| `sandbox_dispatch_reservations` |   100,000 |    8.9 MiB |   5.6 MiB |  14.5 MiB |                  1.000 |
| `usage_records`                 | 1,000,000 |  211.2 MiB | 108.0 MiB | 319.2 MiB |                  1.000 |
| `dispatch_attempts`             |   100,000 |   13.5 MiB |   8.2 MiB |  21.7 MiB |                  1.000 |

## Plans

Each plan is `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` from PostgreSQL 16. Verbose node outputs expose projected columns; index conditions and heap fetches make column and covering-index reviews possible. Mutating retention and idempotency statements ran in transactions that were rolled back. The statement shape comes from the repository SQL constants where available; Sandbox ORM reads are represented by their mapped SQL predicates.

### API-key lookup by hash

Tables: `api_keys` 100,000 rows/29.9 MiB, `organizations` 100 rows/80.0 KiB.
Planning: 0.427 ms; execution: 0.119 ms.
Indexes observed: `api_keys_hash_uq`.
Expected indexes observed: `api_keys_hash_uq`. Missing: none.
Expected sequential scans observed: `organizations`. Missing: none.
Sequential scans: organizations (100 rows).

- Limit; actual rows=1 loops=1; time=0.087 ms; output=api_key.organization_id, api_key.id, organization.status, api_key.status, api_key.scopes, organization.entitlements, api_key.allowed_environments, api_key.expires_at, organization.rate_limit_rpm, organization.max_concurrent, organization.monthly_request_quota, organization.hard_stop_on_quota; shared buffers hit/read=3/4
  - Hash Join; actual rows=1 loops=1; time=0.086 ms; output=api_key.organization_id, api_key.id, organization.status, api_key.status, api_key.scopes, organization.entitlements, api_key.allowed_environments, api_key.expires_at, organization.rate_limit_rpm, organization.max_concurrent, organization.monthly_request_quota, organization.hard_stop_on_quota; shared buffers hit/read=3/4
    - Seq Scan; organizations; actual rows=100 loops=1; time=0.009 ms; output=organization.id, organization.name, organization.status, organization.entitlements, organization.rate_limit_rpm, organization.max_concurrent, organization.monthly_request_quota, organization.hard_stop_on_quota, organization.created_at, organization.updated_at, organization.created_by_user_account_id; shared buffers hit/read=3/0
    - Hash; actual rows=1 loops=1; time=0.066 ms; output=api_key.organization_id, api_key.id, api_key.status, api_key.scopes, api_key.allowed_environments, api_key.expires_at; shared buffers hit/read=0/4
      - Index Scan; api_keys; using api_keys_hash_uq; actual rows=1 loops=1; time=0.057 ms; index condition=(api_key.key_hash = '\x00000000000000000000000000000000000000000000000000000000000186a0'::bytea); output=api_key.organization_id, api_key.id, api_key.status, api_key.scopes, api_key.allowed_environments, api_key.expires_at; shared buffers hit/read=0/4

### Organization read by primary key

Tables: `organizations` 100 rows/80.0 KiB.
Planning: 0.050 ms; execution: 0.022 ms.
Indexes observed: none.
Expected indexes observed: none. Missing: none.
Expected sequential scans observed: `organizations`. Missing: none.
Sequential scans: organizations (1 rows).

- Seq Scan; organizations; actual rows=1 loops=1; time=0.014 ms; filtered=99; filter=(organizations.id = 'bench_org_099'::text); output=id, status, entitlements, monthly_request_quota; shared buffers hit/read=3/0

### Membership resolution

Tables: `organization_members` 100,000 rows/17.8 MiB, `organizations` 100 rows/80.0 KiB.
Planning: 0.156 ms; execution: 0.049 ms.
Indexes observed: `organization_members_pkey`.
Expected indexes observed: `organization_members_pkey`. Missing: none.
Expected sequential scans observed: `organizations`. Missing: none.
Sequential scans: organizations (1 rows).

- Limit; actual rows=1 loops=1; time=0.034 ms; output=membership.organization_id, membership.user_account_id, organization.status, membership.role, membership.status; shared buffers hit/read=4/3
  - Nested Loop; actual rows=1 loops=1; time=0.033 ms; output=membership.organization_id, membership.user_account_id, organization.status, membership.role, membership.status; shared buffers hit/read=4/3
    - Index Scan; organization_members; using organization_members_pkey; actual rows=1 loops=1; time=0.022 ms; index condition=((membership.organization_id = 'bench_org_099'::text) AND (membership.user_account_id = 'usr_00000000000000000000000001'::text)); output=membership.organization_id, membership.user_account_id, membership.role, membership.status, membership.created_at, membership.updated_at; shared buffers hit/read=1/3
    - Seq Scan; organizations; actual rows=1 loops=1; time=0.009 ms; filtered=99; filter=(organization.id = 'bench_org_099'::text); output=organization.id, organization.name, organization.status, organization.entitlements, organization.rate_limit_rpm, organization.max_concurrent, organization.monthly_request_quota, organization.hard_stop_on_quota, organization.created_at, organization.updated_at, organization.created_by_user_account_id; shared buffers hit/read=3/0

### Membership roster for caller

Tables: `organization_members` 100,000 rows/17.8 MiB, `organizations` 100 rows/80.0 KiB, `organization_identity_configs`, `user_accounts` 1,000 rows/248.0 KiB.
Planning: 1.226 ms; execution: 135.929 ms.
Indexes observed: `organization_members_user_account_idx`, `organization_members_pkey`, `user_accounts_pkey`.
Expected indexes observed: `organization_members_user_account_idx`, `organization_members_pkey`, `user_accounts_pkey`. Missing: none.
Expected sequential scans observed: `organization_identity_configs`, `organizations`. Missing: none.
Sequential scans: organization_identity_configs (0 rows), organizations (100 rows).

- Incremental Sort; actual rows=100000 loops=1; time=132.370 ms; output=caller.organization_id, organization.name, organization.status, organization.entitlements, identity_config.status, caller.role, member_account.username, member.role; shared buffers hit/read=4787/838
  - Nested Loop; actual rows=100000 loops=1; time=92.083 ms; output=caller.organization_id, organization.name, organization.status, organization.entitlements, identity_config.status, caller.role, member_account.username, member.role; shared buffers hit/read=4787/838
    - Nested Loop; actual rows=100000 loops=1; time=63.233 ms; output=caller.organization_id, caller.role, organization.name, organization.status, organization.entitlements, identity_config.status, member.role, member.user_account_id; shared buffers hit/read=1791/834
      - Merge Join; actual rows=100 loops=1; time=0.562 ms; output=caller.organization_id, caller.role, organization.name, organization.status, organization.entitlements, organization.id, identity_config.status; shared buffers hit/read=105/0
        - Sort; actual rows=100 loops=1; time=0.285 ms; output=caller.organization_id, caller.role, identity_config.status; shared buffers hit/read=102/0; sort=quicksort 29 Memory
          - Hash Join; actual rows=100 loops=1; time=0.200 ms; output=caller.organization_id, caller.role, identity_config.status; shared buffers hit/read=102/0
            - Bitmap Heap Scan; organization_members; actual rows=100 loops=1; time=0.179 ms; filtered=0; filter=(caller.status = 'active'::text); output=caller.organization_id, caller.user_account_id, caller.role, caller.status, caller.created_at, caller.updated_at; shared buffers hit/read=102/0
              - Bitmap Index Scan; using organization_members_user_account_idx; actual rows=100 loops=1; time=0.044 ms; index condition=(caller.user_account_id = 'usr_00000000000000000000000001'::text); shared buffers hit/read=2/0
            - Hash; actual rows=0 loops=1; time=0.005 ms; output=identity_config.status, identity_config.organization_id
              - Seq Scan; organization_identity_configs; actual rows=0 loops=1; time=0.004 ms; output=identity_config.status, identity_config.organization_id
        - Sort; actual rows=100 loops=1; time=0.068 ms; output=organization.name, organization.status, organization.entitlements, organization.id; shared buffers hit/read=3/0; sort=quicksort 36 Memory
          - Seq Scan; organizations; actual rows=100 loops=1; time=0.011 ms; output=organization.name, organization.status, organization.entitlements, organization.id; shared buffers hit/read=3/0
      - Memoize; actual rows=1000 loops=100; time=0.519 ms; output=member.role, member.organization_id, member.user_account_id; shared buffers hit/read=1686/834
        - Index Scan; organization_members; using organization_members_pkey; actual rows=1000 loops=100; time=0.244 ms; filtered=0; index condition=(member.organization_id = caller.organization_id); filter=(member.status = 'active'::text); output=member.role, member.organization_id, member.user_account_id; shared buffers hit/read=1686/834
    - Memoize; actual rows=1 loops=100000; time=0.000 ms; output=member_account.username, member_account.id; shared buffers hit/read=2996/4
      - Index Scan; user_accounts; using user_accounts_pkey; actual rows=1 loops=1000; time=0.001 ms; index condition=(member_account.id = member.user_account_id); output=member_account.username, member_account.id; shared buffers hit/read=2996/4

### Organization membership list

Tables: `organization_members` 100,000 rows/17.8 MiB, `organizations` 100 rows/80.0 KiB, `user_accounts` 1,000 rows/248.0 KiB.
Planning: 0.527 ms; execution: 1.022 ms.
Indexes observed: `organization_members_pkey`.
Expected indexes observed: `organization_members_pkey`. Missing: none.
Expected sequential scans observed: `organizations`, `user_accounts`. Missing: none.
Sequential scans: organizations (1 rows), organizations (1 rows), user_accounts (1000 rows).

- Sort; actual rows=1000 loops=1; time=0.885 ms; output=($0), member_account.username, membership.role, membership.status; shared buffers hit/read=52/0; sort=quicksort 79 Memory
  - Nested Loop; actual rows=1 loops=1; time=0.017 ms; shared buffers hit/read=7/0
    - Index Scan; organization_members; using organization_members_pkey; actual rows=1 loops=1; time=0.009 ms; filtered=0; index condition=((caller.organization_id = 'bench_org_099'::text) AND (caller.user_account_id = 'usr_00000000000000000000000001'::text)); filter=((caller.role = ANY ('{owner,admin}'::text[])) AND (caller.status = 'active'::text)); output=caller.organization_id, caller.user_account_id, caller.role, caller.status, caller.created_at, caller.updated_at; shared buffers hit/read=4/0
    - Seq Scan; organizations; actual rows=1 loops=1; time=0.007 ms; filtered=99; filter=((organization.id = 'bench_org_099'::text) AND (organization.status = 'active'::text)); output=organization.id, organization.name, organization.status, organization.entitlements, organization.rate_limit_rpm, organization.max_concurrent, organization.monthly_request_quota, organization.hard_stop_on_quota, organization.created_at, organization.updated_at, organization.created_by_user_account_id; shared buffers hit/read=3/0
  - Nested Loop; actual rows=1 loops=1; time=0.023 ms; shared buffers hit/read=7/0
    - Index Scan; organization_members; using organization_members_pkey; actual rows=1 loops=1; time=0.010 ms; filtered=0; index condition=((caller_1.organization_id = 'bench_org_099'::text) AND (caller_1.user_account_id = 'usr_00000000000000000000000001'::text)); filter=((caller_1.role = ANY ('{owner,admin}'::text[])) AND (caller_1.status = 'active'::text)); output=caller_1.organization_id, caller_1.user_account_id, caller_1.role, caller_1.status, caller_1.created_at, caller_1.updated_at; shared buffers hit/read=4/0
    - Seq Scan; organizations; actual rows=1 loops=1; time=0.012 ms; filtered=99; filter=((organization_1.id = 'bench_org_099'::text) AND (organization_1.status = 'active'::text)); output=organization_1.id, organization_1.name, organization_1.status, organization_1.entitlements, organization_1.rate_limit_rpm, organization_1.max_concurrent, organization_1.monthly_request_quota, organization_1.hard_stop_on_quota, organization_1.created_at, organization_1.updated_at, organization_1.created_by_user_account_id; shared buffers hit/read=3/0
  - Hash Join; actual rows=1000 loops=1; time=0.650 ms; output=$0, member_account.username, membership.role, membership.status; shared buffers hit/read=52/0
    - Nested Loop; actual rows=1000 loops=1; time=0.250 ms; output=membership.role, membership.status, membership.user_account_id; shared buffers hit/read=32/0
      - Result; actual rows=1 loops=1; time=0.002 ms
      - Index Scan; organization_members; using organization_members_pkey; actual rows=1000 loops=1; time=0.157 ms; filtered=0; index condition=(membership.organization_id = 'bench_org_099'::text); filter=(membership.status = 'active'::text); output=membership.organization_id, membership.user_account_id, membership.role, membership.status, membership.created_at, membership.updated_at; shared buffers hit/read=25/0
    - Hash; actual rows=1000 loops=1; time=0.235 ms; output=member_account.username, member_account.id; shared buffers hit/read=13/0
      - Seq Scan; user_accounts; actual rows=1000 loops=1; time=0.087 ms; output=member_account.username, member_account.id; shared buffers hit/read=13/0

### Idempotency conflicting reservation insert

Tables: `idempotency_records` 100,000 rows/35.6 MiB.
Planning: 0.029 ms; execution: 0.117 ms.
Indexes observed: `idempotency_records_scope_key`.
Expected indexes observed: `idempotency_records_scope_key`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- ModifyTable; idempotency_records; actual rows=0 loops=1; time=0.105 ms; output=idempotency_records.request_id; shared buffers hit/read=4/0; conflict arbiter=idempotency_records_scope_key
  - Result; actual rows=1 loops=1; time=0.002 ms; output='bench_org_099'::text, 'writing.task2.grade'::text, 'baseline-conflict'::text, '\x00000000000000000000000000000000000000000000000000000000000186a0'::bytea, 'pending'::text, 'bench_conflict_probe'::text, NULL::integer, NULL::jsonb, now(), NULL::timestamp with time zone, '2026-10-22 02:46:49.717+00'::timestamp with time zone, 'baseline'::text

### Idempotency reservation read after conflict

Tables: `idempotency_records` 100,000 rows/35.6 MiB.
Planning: 0.176 ms; execution: 0.034 ms.
Indexes observed: `idempotency_records_scope_key`.
Expected indexes observed: `idempotency_records_scope_key`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Limit; actual rows=1 loops=1; time=0.019 ms; output=(encode(request_fingerprint, 'hex'::text)), state, request_id, response_status, response_body; shared buffers hit/read=4/0
  - Index Scan; idempotency_records; using idempotency_records_scope_key; actual rows=1 loops=1; time=0.018 ms; index condition=((idempotency_records.organization_id = 'bench_org_099'::text) AND (idempotency_records.operation = 'writing.task2.grade'::text) AND (idempotency_records.actor_scope = 'baseline'::text) AND (idempotency_records.idempotency_key = 'baseline-conflict'::text)); output=encode(request_fingerprint, 'hex'::text), state, request_id, response_status, response_body; shared buffers hit/read=4/0

### Completed idempotency replay read

Tables: `idempotency_records` 100,000 rows/35.6 MiB.
Planning: 0.142 ms; execution: 0.038 ms.
Indexes observed: `idempotency_records_scope_key`.
Expected indexes observed: `idempotency_records_scope_key`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Limit; actual rows=1 loops=1; time=0.022 ms; output=request_id, state, response_status, response_body; shared buffers hit/read=4/0
  - Index Scan; idempotency_records; using idempotency_records_scope_key; actual rows=1 loops=1; time=0.021 ms; filtered=0; index condition=((idempotency_records.organization_id = 'bench_org_099'::text) AND (idempotency_records.operation = 'writing.task2.grade'::text) AND (idempotency_records.actor_scope = 'baseline'::text) AND (idempotency_records.idempotency_key = 'baseline-conflict'::text)); filter=((idempotency_records.request_fingerprint = '\x00000000000000000000000000000000000000000000000000000000000186a0'::bytea) AND (idempotency_records.state = 'completed'::text) AND (idempotency_records.expires_at > now())); output=request_id, state, response_status, response_body; shared buffers hit/read=4/0

### Sandbox allowance override read

Tables: `sandbox_allowance_overrides` 1 rows/32.0 KiB.
Planning: 0.052 ms; execution: 0.028 ms.
Indexes observed: `sandbox_allowance_overrides_pkey`.
Expected indexes observed: `sandbox_allowance_overrides_pkey`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Index Scan; sandbox_allowance_overrides; using sandbox_allowance_overrides_pkey; actual rows=1 loops=1; time=0.015 ms; index condition=((sandbox_allowance_overrides.organization_id = 'bench_org_099'::text) AND (sandbox_allowance_overrides.month_start = '2026-10-01'::date)); output=allowance; shared buffers hit/read=1/1

### Sandbox allowance default read

Tables: `sandbox_allowance_defaults` 2 rows/24.0 KiB.
Planning: 0.060 ms; execution: 0.040 ms.
Indexes observed: `sandbox_allowance_defaults_pkey`.
Expected indexes observed: `sandbox_allowance_defaults_pkey`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Limit; actual rows=1 loops=1; time=0.029 ms; output=allowance, month_start; shared buffers hit/read=1/1
  - Index Scan; sandbox_allowance_defaults; using sandbox_allowance_defaults_pkey; actual rows=1 loops=1; time=0.028 ms; index condition=(sandbox_allowance_defaults.month_start <= '2026-10-01'::date); output=allowance, month_start; shared buffers hit/read=1/1

### Sandbox reservation count by Organization

Tables: `sandbox_dispatch_reservations` 100,000 rows/14.5 MiB.
Planning: 0.157 ms; execution: 1.360 ms.
Indexes observed: `sandbox_dispatch_reservations_month_idx`.
Expected indexes observed: `sandbox_dispatch_reservations_month_idx`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Aggregate; actual rows=1 loops=1; time=1.296 ms; output=count(*); shared buffers hit/read=1002/0
  - Bitmap Heap Scan; sandbox_dispatch_reservations; actual rows=1000 loops=1; time=1.245 ms; shared buffers hit/read=1002/0
    - Bitmap Index Scan; using sandbox_dispatch_reservations_month_idx; actual rows=1000 loops=1; time=0.164 ms; index condition=((sandbox_dispatch_reservations.month_start = '2026-10-01'::date) AND (sandbox_dispatch_reservations.organization_id = 'bench_org_099'::text)); shared buffers hit/read=2/0

### Sandbox reservation count by Environment

Tables: `sandbox_dispatch_reservations` 100,000 rows/14.5 MiB.
Planning: 0.064 ms; execution: 12.958 ms.
Indexes observed: none.
Expected indexes observed: none. Missing: none.
Expected sequential scans observed: `sandbox_dispatch_reservations`. Missing: none.
Sequential scans: sandbox_dispatch_reservations (100000 rows).

- Aggregate; actual rows=1 loops=1; time=12.938 ms; output=count(*); shared buffers hit/read=1137/0
  - Seq Scan; sandbox_dispatch_reservations; actual rows=100000 loops=1; time=9.376 ms; filtered=0; filter=((sandbox_dispatch_reservations.status = 'reserved'::text) AND (sandbox_dispatch_reservations.month_start = '2026-10-01'::date)); output=request_id, organization_id, month_start, status, created_at, released_at; shared buffers hit/read=1137/0

### Request and token metering aggregate

Tables: `usage_records` 1,000,000 rows/319.2 MiB.
Planning: 0.195 ms; execution: 1.305 ms.
Indexes observed: `usage_org_time_idx`.
Expected indexes observed: `usage_org_time_idx`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Aggregate; actual rows=1 loops=1; time=1.263 ms; output=COALESCE(sum(billable_requests) FILTER (WHERE (outcome = 'success'::text)), '0'::bigint), COALESCE(sum(total_tokens) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1))), '0'::bigint), count(*) FILTER (WHERE ((outcome = 'success'::text) AND (metering_status = 'missing_usage'::text))); shared buffers hit/read=958/11
  - Bitmap Heap Scan; usage_records; actual rows=958 loops=1; time=1.178 ms; output=billable_requests, outcome, total_tokens, metering_status; shared buffers hit/read=958/11
    - Bitmap Index Scan; using usage_org_time_idx; actual rows=958 loops=1; time=0.277 ms; index condition=((usage_records.organization_id = 'bench_org_099'::text) AND (usage_records.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone) AND (usage_records.created_at < '2026-11-01 00:00:00+00'::timestamp with time zone)); shared buffers hit/read=0/11

### Metering usage completeness aggregate

Tables: `usage_records` 1,000,000 rows/319.2 MiB.
Planning: 0.125 ms; execution: 107.699 ms.
Indexes observed: `usage_created_brin`.
Expected indexes observed: `usage_created_brin`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- Aggregate; actual rows=4 loops=1; time=107.627 ms; output=operation, count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1))), count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1) AND (metering_status = 'missing_usage'::text))); shared buffers hit/read=18/26903
  - Gather Merge; actual rows=12 loops=1; time=107.616 ms; output=operation, (PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1)))), (PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1) AND (metering_status = 'missing_usage'::text)))); shared buffers hit/read=18/26903
    - Sort; actual rows=4 loops=3; time=90.590 ms; output=operation, (PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1)))), (PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1) AND (metering_status = 'missing_usage'::text)))); shared buffers hit/read=18/26903; sort=quicksort 25 Memory
      - Aggregate; actual rows=4 loops=3; time=90.556 ms; output=operation, PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1))), PARTIAL count(_) FILTER (WHERE ((outcome = 'success'::text) AND (billable_requests = 1) AND (metering_status = 'missing_usage'::text))); shared buffers hit/read=2/26903
        - Bitmap Heap Scan; usage_records; actual rows=31930 loops=3; time=85.298 ms; filtered=0; filter=(usage_records.operation = ANY ('{writing.task1.grade,writing.task2.grade,speaking.grade,speaking.grade-json}'::text[])); output=operation, outcome, billable_requests, metering_status; shared buffers hit/read=2/26903
          - Bitmap Index Scan; using usage_created_brin; actual rows=269000 loops=1; time=0.601 ms; index condition=((usage_records.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone) AND (usage_records.created_at < '2026-11-01 00:00:00+00'::timestamp with time zone)); shared buffers hit/read=2/3

### Monthly quota reconciliation aggregate

Tables: `organizations` 100 rows/80.0 KiB, `usage_records` 1,000,000 rows/319.2 MiB.
Planning: 0.305 ms; execution: 195.059 ms.
Indexes observed: `usage_created_brin`.
Expected indexes observed: `usage_created_brin`. Missing: none.
Expected sequential scans observed: `organizations`. Missing: none.
Sequential scans: organizations (100 rows).

- Sort; actual rows=100 loops=1; time=194.928 ms; output=o.id, o.monthly_request_quota, (COALESCE(sum(u.billable_requests) FILTER (WHERE (u.outcome = 'success'::text)), '0'::bigint)); shared buffers hit/read=4/26901; sort=quicksort 30 Memory
  - Aggregate; actual rows=100 loops=1; time=194.859 ms; output=o.id, o.monthly_request_quota, COALESCE(sum(u.billable_requests) FILTER (WHERE (u.outcome = 'success'::text)), '0'::bigint); shared buffers hit/read=4/26901
    - Hash Join; actual rows=95790 loops=1; time=181.558 ms; output=o.id, o.monthly_request_quota, u.billable_requests, u.outcome; shared buffers hit/read=4/26901
      - Bitmap Heap Scan; usage_records; actual rows=95790 loops=1; time=169.423 ms; output=u.billable_requests, u.outcome, u.organization_id; shared buffers hit/read=1/26901
        - Bitmap Index Scan; using usage_created_brin; actual rows=269000 loops=1; time=0.302 ms; index condition=((u.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone) AND (u.created_at < '2026-11-01 00:00:00+00'::timestamp with time zone)); shared buffers hit/read=1/1
      - Hash; actual rows=100 loops=1; time=0.037 ms; output=o.id, o.monthly_request_quota; shared buffers hit/read=3/0
        - Seq Scan; organizations; actual rows=100 loops=1; time=0.016 ms; filtered=0; filter=(o.monthly_request_quota IS NOT NULL); output=o.id, o.monthly_request_quota; shared buffers hit/read=3/0

### Monthly billing aggregate

Tables: `usage_records` 1,000,000 rows/319.2 MiB, `api_keys` 100,000 rows/29.9 MiB.
Planning: 0.647 ms; execution: 134.645 ms.
Indexes observed: `usage_created_brin`.
Expected indexes observed: `usage_created_brin`. Missing: none.
Expected sequential scans observed: `api_keys`. Missing: none.
Sequential scans: api_keys (33333 rows).

- Aggregate; actual rows=100 loops=1; time=134.441 ms; output=u.organization_id, u.operation, count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'response'::text))), count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'background_completion'::text))), count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.metering_status = 'quota_unverified'::text))), count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 0))), count(_) FILTER (WHERE (u.outcome <> 'success'::text)), count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND COALESCE(k.internal, false))), count(*) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment <> 'production'::text))); shared buffers hit/read=21/29403
  - Gather Merge; actual rows=300 loops=1; time=134.373 ms; output=u.organization_id, u.operation, (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'response'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'background_completion'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.metering_status = 'quota_unverified'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 0)))), (PARTIAL count(_) FILTER (WHERE (u.outcome <> 'success'::text))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND COALESCE(k.internal, false)))), (PARTIAL count(*) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment <> 'production'::text)))); shared buffers hit/read=21/29403
    - Sort; actual rows=100 loops=3; time=116.357 ms; output=u.organization_id, u.operation, (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'response'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'background_completion'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.metering_status = 'quota_unverified'::text)))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 0)))), (PARTIAL count(_) FILTER (WHERE (u.outcome <> 'success'::text))), (PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND COALESCE(k.internal, false)))), (PARTIAL count(*) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment <> 'production'::text)))); shared buffers hit/read=21/29403; sort=quicksort 36 Memory
      - Aggregate; actual rows=100 loops=3; time=116.241 ms; output=u.organization_id, u.operation, PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'response'::text))), PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.billing_basis = 'background_completion'::text))), PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND (NOT COALESCE(k.internal, false)) AND (u.metering_status = 'quota_unverified'::text))), PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 0))), PARTIAL count(_) FILTER (WHERE (u.outcome <> 'success'::text)), PARTIAL count(_) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment = 'production'::text) AND COALESCE(k.internal, false))), PARTIAL count(*) FILTER (WHERE ((u.outcome = 'success'::text) AND (u.billable_requests = 1) AND (u.environment <> 'production'::text))); shared buffers hit/read=5/29403
        - Hash Join; actual rows=31930 loops=3; time=97.552 ms; output=u.organization_id, u.operation, u.outcome, u.billable_requests, u.environment, k.internal, u.billing_basis, u.metering_status; shared buffers hit/read=5/29403
          - Bitmap Heap Scan; usage_records; actual rows=31930 loops=3; time=74.084 ms; output=u.organization_id, u.operation, u.outcome, u.billable_requests, u.environment, u.billing_basis, u.metering_status, u.api_key_id; shared buffers hit/read=1/26901
            - Bitmap Index Scan; using usage_created_brin; actual rows=269000 loops=1; time=0.301 ms; index condition=((u.created_at >= '2026-10-01 00:00:00+00'::timestamp with time zone) AND (u.created_at < '2026-11-01 00:00:00+00'::timestamp with time zone)); shared buffers hit/read=1/1
          - Hash; actual rows=33333 loops=3; time=12.444 ms; output=k.internal, k.id; shared buffers hit/read=0/2500
            - Seq Scan; api_keys; actual rows=33333 loops=3; time=5.310 ms; output=k.internal, k.id; shared buffers hit/read=0/2500

### Usage-record retention batch

Tables: `usage_records` 1,000,000 rows/319.2 MiB.
Planning: 0.144 ms; execution: 408.493 ms.
Indexes observed: `usage_created_brin`, `usage_records_pkey`.
Expected indexes observed: `usage_created_brin`, `usage_records_pkey`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- ModifyTable; usage_records; actual rows=500 loops=1; time=403.613 ms; output=usage.created_at, usage.request_id; shared buffers hit/read=3509/27049; temp blocks read/written=5532/10091
  - Limit; actual rows=500 loops=1; time=401.251 ms; output=usage_records.request_id, usage_records.created_at, usage_records.ctid; shared buffers hit/read=500/27044; temp blocks read/written=5532/10091
    - LockRows; actual rows=500 loops=1; time=401.219 ms; output=usage_records.request_id, usage_records.created_at, usage_records.ctid; shared buffers hit/read=500/27044; temp blocks read/written=5532/10091
      - Sort; actual rows=500 loops=1; time=400.888 ms; output=usage_records.request_id, usage_records.created_at, usage_records.ctid; shared buffers hit/read=1/27029; temp blocks read/written=5532/10091; sort=external merge 40320 Disk
        - Bitmap Heap Scan; usage_records; actual rows=857143 loops=1; time=194.311 ms; output=usage_records.request_id, usage_records.created_at, usage_records.ctid; shared buffers hit/read=1/27029
          - Bitmap Index Scan; using usage_created_brin; actual rows=270280 loops=1; time=0.296 ms; index condition=(usage_records.created_at < '2026-09-21 02:46:49.717+00'::timestamp with time zone); shared buffers hit/read=1/1
  - Nested Loop; actual rows=500 loops=1; time=403.238 ms; output=usage.ctid, candidates.*; shared buffers hit/read=2495/27049; temp blocks read/written=5532/10091
    - CTE Scan; actual rows=500 loops=1; time=402.037 ms; output=candidates.*, candidates.request_id; shared buffers hit/read=500/27044; temp blocks read/written=5532/10091
    - Index Scan; usage_records; using usage_records_pkey; actual rows=1 loops=500; time=0.002 ms; index condition=(usage.request_id = candidates.request_id); output=usage.ctid, usage.request_id; shared buffers hit/read=1995/5

### Dispatch-attempt retention batch

Tables: `dispatch_attempts` 100,000 rows/21.7 MiB.
Planning: 0.185 ms; execution: 2.261 ms.
Indexes observed: `dispatch_attempts_retention_idx`, `dispatch_attempts_pkey`.
Expected indexes observed: `dispatch_attempts_retention_idx`, `dispatch_attempts_pkey`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- ModifyTable; dispatch_attempts; actual rows=500 loops=1; time=2.150 ms; output=attempt.attempt_id; shared buffers hit/read=3189/343
  - Limit; actual rows=500 loops=1; time=0.301 ms; output=dispatch_attempts.attempt_id, dispatch_attempts.created_at, dispatch_attempts.ctid; shared buffers hit/read=508/15
    - LockRows; actual rows=500 loops=1; time=0.270 ms; output=dispatch_attempts.attempt_id, dispatch_attempts.created_at, dispatch_attempts.ctid; shared buffers hit/read=508/15
      - Index Scan; dispatch_attempts; using dispatch_attempts_retention_idx; actual rows=500 loops=1; time=0.124 ms; index condition=(dispatch_attempts.created_at < '2026-09-21 02:46:49.717+00'::timestamp with time zone); output=dispatch_attempts.attempt_id, dispatch_attempts.created_at, dispatch_attempts.ctid; shared buffers hit/read=0/14
  - Nested Loop; actual rows=500 loops=1; time=1.921 ms; output=attempt.ctid, candidates.*; shared buffers hit/read=2180/343
    - CTE Scan; actual rows=500 loops=1; time=0.488 ms; output=candidates.*, candidates.attempt_id; shared buffers hit/read=508/15
    - Index Scan; dispatch_attempts; using dispatch_attempts_pkey; actual rows=1 loops=500; time=0.003 ms; index condition=(attempt.attempt_id = candidates.attempt_id); output=attempt.ctid, attempt.attempt_id; shared buffers hit/read=1672/328

### Expired idempotency cleanup

Tables: `idempotency_records` 100,000 rows/35.6 MiB.
Planning: 0.109 ms; execution: 37.023 ms.
Indexes observed: `idempotency_records_expires_idx`.
Expected indexes observed: `idempotency_records_expires_idx`. Missing: none.
Expected sequential scans observed: none. Missing: none.
Sequential scans: none.

- ModifyTable; idempotency_records; actual rows=49999 loops=1; time=35.336 ms; output=request_id; shared buffers hit/read=102629/2674
  - Bitmap Heap Scan; idempotency_records; actual rows=49999 loops=1; time=13.125 ms; output=ctid; shared buffers hit/read=0/2673
    - Bitmap Index Scan; using idempotency_records_expires_idx; actual rows=49999 loops=1; time=0.929 ms; index condition=(idempotency_records.expires_at <= now()); shared buffers hit/read=0/41

## Findings

The organization and user-account scans shown above are expected for the 100-row and 1,000-row dimension tables. The monthly Sandbox reservation count also scans all 100,000 rows because it aggregates every reservation for the month; its per-organization counterpart uses `sandbox_dispatch_reservations_month_idx`. The broad monthly metering and billing aggregates use the date BRIN index, with sequential scans for their organization/key dimensions.

Usage retention measured 1,000,000 rows/319.2 MiB and 857,143 expired candidates; the batch returned 500 rows in 408.493 ms. Its sort external merge sort spilled 40,320 KiB to disk. The sibling dispatch batch took 2.261 ms. The `(created_at, request_id)` ordering gap is recorded as a follow-up in [#282](https://github.com/AiHub-Ecosystem/aihub-be/issues/282#issuecomment-6210953806); no index was added in this baseline.

The API-key lookup projects the fields consumed by `ApiKeyRecord` and does not select the stored key hash. Completed idempotency replay reads `response_body` for the replay response. The reviewed projections contain no unused wide fields; EXPLAIN exposes output columns but does not report TOAST fetches separately. Index-only scans observed: none; the selective lookups visit the heap for required projected fields. The plans do not justify an INCLUDE index.

## Scope and cadence

This is a repeatable synthetic-data plan baseline. Rerun after changes to any listed query, index, or table schema, and at least quarterly. Compare plans and relation sizes; file index changes separately and only when the measured plan warrants them. Do not use these timings as a Production rate limit.

## Downstream pool observation

The gateway creates one Undici Pool per origin with 10 connections, HTTP/2 enabled, a 300,000 ms keep-alive timeout, and a 600,000 ms maximum. `pnpm capacity:benchmark` records `downstreamQueuedPeak` from `aihub_downstream_pool_queued`; that is queue depth, not a socket-reuse or handshake counter. This database run does not make provider requests, so runtime connection reuse remains unmeasured.

Production `pg_stat_statements` status is recorded in [the observability runbook](aihub-observability.md#statement-statistics-and-privacy-gate): as of 2026-10-16, version 1.10 was available but not installed in any connectable AIHUB database. #299 tracks queryable slow-statement evidence; this baseline did not change the shared cluster configuration.

Recreate the baseline with `AIHUB_POSTGRES_BASELINE=1 pnpm benchmark:postgres-plans` from PowerShell. The command requires the local `aihub` test-lane marker, takes the database-lane advisory lock, creates a uniquely named disposable database, applies checked-in migrations, seeds synthetic rows, writes this report, and drops only the database it created.
