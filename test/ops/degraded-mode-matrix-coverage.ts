/**
 * Proof map for docs/superpowers/specs/2026-09-07-aihub/14-degraded-mode-matrix.md.
 *
 * Keys are `<section heading> / <seam and failure cell>` copied from the matrix,
 * so editing a row forces a review of its proof. A few keys name obligations the
 * matrix states in prose rather than in a table row.
 *
 * #2019 stays open while any proof is `pending` or a tested proof lists `gaps`.
 */
export interface MatrixSpec {
  /** Repo-relative path of the spec. */
  file: string;
  /** Exact test titles, as written in the spec (`%s` included for `it.each`). */
  titles: string[];
}

export type MatrixProof =
  | { tests: MatrixSpec[]; gaps?: string }
  | { untestable: string }
  | { pending: string };

const FAULT = 'test/db/tenant-isolation/fault-injection/';

/** Obligations from the matrix prose that have no table row of their own. */
export const PROSE_OBLIGATIONS = [
  'Readiness and recovery proof / PostgreSQL and Redis outage with same-process /ready recovery',
  'Readiness and recovery proof / DNS/IP cutover to a new endpoint without restart',
  'Test and ownership links / Compound dependency fault under load',
] as const;

export const DEGRADED_MODE_PROOF: Record<string, MatrixProof> = {
  'Redis / Graded rate-limit decision is down, slow, ambiguous, or malformed': {
    tests: [
      {
        file: `${FAULT}gateway-redis-fault.spec.ts`,
        titles: [
          'refuses graded admission with a retryable 503 inside the bound, then admits again',
        ],
      },
    ],
  },
  'Redis / Organization retry-budget decision is down, slow, ambiguous, or malformed':
    {
      tests: [
        {
          file: `${FAULT}retry-budget-fault.spec.ts`,
          titles: [
            'fails closed on Redis disconnects and slow commands, then recovers',
          ],
        },
      ],
    },
  'Redis / Graded monthly quota admission is unavailable or its counter is missing':
    {
      tests: [
        {
          file: `${FAULT}lost-keys-fault.spec.ts`,
          titles: [
            'rebuilds a lost quota counter from durable usage, once, for concurrent first requests',
            'refuses a hard-stop Organization whose durable usage already meets its quota',
          ],
        },
      ],
      gaps: 'No case fails the durable-usage source during a rebuild: hard-stop Organizations failing closed and others admitted as quota_unverified are unproven.',
    },
  'Redis / Graded concurrency permit is down, slow, ambiguous, or malformed': {
    tests: [
      {
        file: `${FAULT}gateway-redis-fault.spec.ts`,
        titles: [
          'refuses a %s concurrency permit without admitting locally and leaks no lease',
          'frees a permit after Redis returns beyond the bounded retry attempts',
        ],
      },
    ],
  },
  'Redis / Post-result quota counter increment fails': {
    pending:
      'No fault-proxy case for a failed post-result counter increment; unit coverage only in src/modules/metering/infrastructure/quota/redis-quota-counter.spec.ts.',
  },
  'Redis / Non-graded rate limiter is down or slow': {
    pending:
      'Matrix/code conflict: gateway.module.ts binds RATE_LIMITER to RedisRateLimiter, which fails closed with REDIS_UNAVAILABLE (gateway-redis-fault.spec.ts), and RateLimitGuard has no process-local fallback, while the matrix promises one. #372 decides which side moves.',
  },
  'Redis / Authentication rate limiter is down or slow': {
    tests: [
      {
        file: `${FAULT}identity-redis-fault.spec.ts`,
        titles: ['keeps local-auth rate limits at a process-local ceiling'],
      },
    ],
  },
  'Redis / Authentication-failure counter or uncached API-key lookup budget is down or slow':
    {
      tests: [
        {
          file: `${FAULT}identity-redis-fault.spec.ts`,
          titles: [
            'authenticates from Postgres and never grants an unknown key',
          ],
        },
      ],
      gaps: 'The fault case proves the seam signal and the process-local fallback; the 300 s / 10,000-entry failure map and the 5 req/s burst-5 bucket are unit-only (redis-identity.store.spec.ts).',
    },
  'Redis / API-key cache is down, slow, corrupt, or missing': {
    tests: [
      {
        file: `${FAULT}identity-redis-fault.spec.ts`,
        titles: ['authenticates from Postgres and never grants an unknown key'],
      },
    ],
  },
  'Redis / API-key revoke cache invalidation fails': {
    pending:
      'Unit coverage only (organization-api-key-revoke.controller.spec.ts, redis-identity.store.spec.ts); no fault-proxy case.',
  },
  'Redis / API-key rotation cache invalidation fails': {
    pending:
      'Unit coverage only (organization-api-key-rotate.controller.spec.ts); no fault-proxy case.',
  },
  'Redis / Organization suspension cache invalidation fails': {
    pending:
      'Unit coverage only (src/cli/organization-status.spec.ts); no fault-proxy case.',
  },
  'Redis / Customer JWKS cache is down, slow, corrupt, or missing': {
    tests: [
      {
        file: `${FAULT}identity-redis-fault.spec.ts`,
        titles: ['fails closed when Redis cannot reserve a verified assertion'],
      },
    ],
    gaps: 'The case proves the fallback to the JWKS source and the jwks_cache signal; its 503 comes from the replay-marker reservation. No case proves 503 IDENTITY_PROVIDER_UNAVAILABLE with no usable cache and an unavailable source.',
  },
  'Redis / DPoP replay marker is down or ambiguous': {
    pending:
      'Unit coverage only (redis-dpop-replay-cache.spec.ts); no fault-proxy case for a down or ambiguous replay marker.',
  },
  'Redis / User Access JWT revocation publish or subscriber is down': {
    pending:
      'Unit coverage only (bloom-filter-user-access-token-revocation.adapter.spec.ts); no fault-proxy case for a down publish or subscriber.',
  },
  'Redis / Gateway shared load-shedding level is down, slow, or unavailable': {
    pending:
      'multi-instance-shedding.spec.ts does not inject a Redis fault; no case proves the 15 s peer-level bound.',
  },
  'Redis / Email-send rate limit is down or slow': {
    pending:
      'Unit coverage only (redis-email-send-rate-limiter.unavailable.spec.ts); no case proves the outbox defers dispatch while Redis is down.',
  },
  'PostgreSQL / Request-path read/write is unreachable, unanswered, or blocked on a lock/statement':
    {
      tests: [
        {
          file: `${FAULT}postgres-fault.spec.ts`,
          titles: [
            'fails API-key lookup and usage writes as a retryable outage inside the bound, then recovers without leaking connections',
            'refuses as a retryable outage inside the bound when Postgres is slower than the connect timeout',
          ],
        },
        {
          file: 'test/db/shared/postgres-timeouts.spec.ts',
          titles: [
            'cancels a held-row lock in a control-plane transaction and returns its connection',
          ],
        },
      ],
    },
  'PostgreSQL / API-key status or Organization Identity Configuration read could use a lagging replica':
    {
      pending:
        'The writer-read target is a code gap tracked by #2020: CONTROL_PLANE_READ wiring still exists. Add a case proving these reads use the writer when #2020 lands.',
    },
  'PostgreSQL / Speaking result-ownership write fails': {
    pending:
      'No fault-proxy case for a failed Speaking result-ownership write.',
  },
  'PostgreSQL / Metering write fails after an otherwise successful result': {
    pending:
      'admission-postgres-fault.spec.ts covers a stalled usage write releasing permits, not the preserved client result or aihub_metering_incomplete_total.',
  },
  'PostgreSQL / Audit/UX read uses a replica': {
    untestable:
      'The matrix forbids replica routing until a measured lag bound exists, so there is no replica read to fault. Whether these reads use the writer is a wiring check, not a fault case.',
  },
  'Vault and runtime secrets / Required secret is missing, malformed, or incomplete at startup':
    {
      pending:
        'Startup failure is not yet covered by a boot-level case in this suite; related: test/vault-approle-autologin.spec.ts.',
    },
  'Vault and runtime secrets / Vault/Agent becomes unavailable after a snapshot is loaded':
    {
      pending:
        'No case proves the process keeps serving its snapshot after Vault or the Agent goes away.',
    },
  'SeaweedFS object storage / Avatar, Speaking audio, or Writing chart storage is down or slow':
    {
      tests: [
        {
          file: 'test/integration/object-storage-deadlines.spec.ts',
          titles: [
            'fails a connected store that never answers instead of merely warning or retrying',
            'fails a refused connection immediately with a retryable 503',
            'fails fast instead of queueing after the shared socket budget is exhausted',
            '%s stops at the caller deadline and returns a safe retryable error',
          ],
        },
      ],
    },
  'SeaweedFS object storage / Operator storage sweep is slow or fails': {
    pending:
      'No case for the operator storage sweep connection and page bounds.',
  },
  'Email provider / Resend returns 429/5xx, times out, or transport fails': {
    pending:
      'Unit coverage only (resend-email.sender.spec.ts); no fault-proxy case for the provider circuit and deferred dispatch.',
  },
  'Email provider / Resend returns credential 401/403': {
    pending:
      'Unit coverage only (resend-email.sender.spec.ts); no case for the credential hold.',
  },
  'AI Services and legacy content backend / Configured AI Service is unavailable, credential-rejected, throttled, or its breaker/bulkhead refuses':
    {
      tests: [
        {
          file: `${FAULT}ai-service-fault.spec.ts`,
          titles: [
            'answers 503 AI_SERVICE_UNAVAILABLE at once when the service refuses connections, and releases the permit',
            'grades again once the service returns',
          ],
        },
      ],
      gaps: 'Only refused connections and recovery are proven; credential 401/403, provider 429 (AI_SERVICE_THROTTLED), and breaker or bulkhead refusal have no fault case.',
    },
  'AI Services and legacy content backend / Configured AI Service returns 5xx, 408, or 425; returns another 4xx; or times out':
    {
      tests: [
        {
          file: `${FAULT}ai-service-fault.spec.ts`,
          titles: [
            'answers 504 AI_SERVICE_TIMEOUT inside the deadline when the service hangs, cancels the call, and releases the permit',
          ],
        },
      ],
      gaps: 'The 5xx/408/425 and other-4xx mappings to 502 AI_SERVICE_ERROR are unit-only.',
    },
  'AI Services and legacy content backend / AI Service returns an invalid/unparseable response':
    {
      pending:
        'Unit coverage only (speaking-grading-response.adapter.spec.ts); no fault-proxy case for an invalid response.',
    },
  'AI Services and legacy content backend / Legacy content backend is down, slow, or returns a wrong response':
    {
      pending:
        'Unit coverage only (http-legacy-content.client.spec.ts); no fault-proxy case. #1949 owns any behavior change.',
    },
  'Customer JWKS endpoints / Customer JWKS source is down, slow, unreachable, or returns unusable data':
    {
      pending:
        'jwks-dns-isolation.integration.spec.ts covers a silent DNS query only; no case for an unreachable or unusable source with and without a stale cache.',
    },
  [PROSE_OBLIGATIONS[0]]: {
    tests: [
      {
        file: `${FAULT}readiness-recovery-fault.spec.ts`,
        titles: [
          'turns ready only after PostgreSQL and Redis come up after startup',
          'answers /ready 503 inside the bound, keeps /health, and recovers without a restart',
          'stays ready while %s is slow inside its bounds',
        ],
      },
    ],
    gaps: 'RECOVERY_BOUND_MS (10 s) is provisional; #749 and #645 own the same-process recovery bounds it must match.',
  },
  [PROSE_OBLIGATIONS[1]]: {
    pending:
      'No DNS cutover case yet; #749 and #645 set the recovery bounds it verifies.',
  },
  [PROSE_OBLIGATIONS[2]]: {
    tests: [
      {
        file: `${FAULT}compound-fault-under-load.spec.ts`,
        titles: [
          'answers every caller retryably inside the deadline with bounded queues and heap, and recovers without a restart',
        ],
      },
    ],
    gaps: 'HEAP_GROWTH_BOUND_BYTES (200 MiB) is provisional; #398 owns the per-process capacity budget it must match.',
  },
};
