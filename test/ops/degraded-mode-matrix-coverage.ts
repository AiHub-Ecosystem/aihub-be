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
    tests: [
      {
        file: `${FAULT}api-key-cache-invalidation-fault.spec.ts`,
        titles: [
          'never fails the committed change when Redis is %s, leaves at most the 60 s positive entry, and a repeat purge removes it',
        ],
      },
      {
        file: 'src/modules/identity/api-keys/presentation/organization-api-key-revoke.controller.spec.ts',
        titles: [
          'still succeeds when the cache purge fails',
          'purges again on a repeated withdrawal, so a retry closes a window a failed purge left open',
        ],
      },
    ],
  },
  'Redis / API-key rotation cache invalidation fails': {
    tests: [
      {
        file: `${FAULT}api-key-cache-invalidation-fault.spec.ts`,
        titles: [
          'never fails the committed change when Redis is %s, leaves at most the 60 s positive entry, and a repeat purge removes it',
        ],
      },
      {
        file: 'src/modules/identity/api-keys/presentation/organization-api-key-rotate.controller.spec.ts',
        titles: ['still returns the replacement when the cache purge fails'],
      },
    ],
  },
  'Redis / Organization suspension cache invalidation fails': {
    tests: [
      {
        file: `${FAULT}api-key-cache-invalidation-fault.spec.ts`,
        titles: [
          'fails the operator purge inside its bound when Redis is %s, leaves at most the 60 s positive entry, and a repeat purges it',
        ],
      },
      {
        file: 'src/cli/organization-status.spec.ts',
        titles: [
          'persists a failed %s purge without changing the committed act',
          'reports a repeat as unchanged and still purges',
        ],
      },
    ],
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
    tests: [
      {
        file: `${FAULT}redis-seam-fault.spec.ts`,
        titles: [
          'rejects a claim inside the bound when Redis is %s and counts the seam',
          'detects a replay again once Redis returns',
        ],
      },
      {
        file: 'src/modules/auth/web-sessions/presentation/user-access-jwt.guard.dpop.spec.ts',
        titles: [
          'fails closed with a retryable 503, never a fallback, when replay state is unavailable',
        ],
      },
    ],
  },
  'Redis / User Access JWT revocation publish or subscriber is down': {
    pending:
      'Unit coverage only (bloom-filter-user-access-token-revocation.adapter.spec.ts); no fault-proxy case for a down publish or subscriber.',
  },
  'Redis / Gateway shared load-shedding level is down, slow, or unavailable': {
    tests: [
      {
        file: `${FAULT}redis-seam-fault.spec.ts`,
        titles: [
          'trusts a peer level for at most 15 s, keeps the local level, and never sheds for Redis alone',
        ],
      },
    ],
  },
  'Redis / Email-send rate limit is down or slow': {
    tests: [
      {
        file: `${FAULT}redis-seam-fault.spec.ts`,
        titles: [
          'defers a send inside the bound when Redis is %s instead of bypassing the shared limit',
          'reserves sends again once Redis returns',
        ],
      },
      {
        // The outbox answer to `reserved: false` is the same whether the cap
        // is full or Redis cannot answer: the request stays queued.
        file: 'src/modules/auth/email-delivery/application/poller/email-delivery-poller.dispatch.spec.ts',
        titles: [
          'keeps a request queued without spending an attempt when the shared rate cap is full',
        ],
      },
    ],
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
        {
          file: `${FAULT}ai-service-response-fault.spec.ts`,
          titles: [
            'answers %s as a retryable 503 AI_SERVICE_UNAVAILABLE and counts a credential failure',
            'answers 429 as a retryable 503 AI_SERVICE_THROTTLED that keeps the provider retry hint',
            'opens the breaker after the failure threshold and refuses at once without calling the service',
            'refuses past the per-origin bulkhead at once with a retryable 503 and counts the drop',
          ],
        },
      ],
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
        {
          file: `${FAULT}ai-service-response-fault.spec.ts`,
          titles: [
            'answers %s as a retryable 502 AI_SERVICE_ERROR',
            'answers %s as a non-retryable 502 AI_SERVICE_ERROR',
            'keeps the breaker closed through ordinary 4xx answers',
          ],
        },
      ],
    },
  'AI Services and legacy content backend / AI Service returns an invalid/unparseable response':
    {
      tests: [
        {
          file: `${FAULT}ai-service-response-fault.spec.ts`,
          titles: [
            'answers %s as a non-retryable 502 AI_SERVICE_CONTRACT_VIOLATION',
          ],
        },
      ],
    },
  'AI Services and legacy content backend / Legacy content backend is down, slow, or returns a wrong response':
    {
      tests: [
        {
          file: `${FAULT}legacy-content-fault.spec.ts`,
          titles: [
            'answers a refused connection at once with a retryable 503 AI_SERVICE_UNAVAILABLE',
            'answers a hung backend with a retryable 504 AI_SERVICE_TIMEOUT at its 10 s timeout',
            'answers upstream %s with a retryable 503 AI_SERVICE_UNAVAILABLE',
            'answers upstream %s with a non-retryable 502 AI_SERVICE_ERROR',
            'answers %s with a non-retryable 502 AI_SERVICE_CONTRACT_VIOLATION',
            'serves content again once the backend returns',
          ],
        },
      ],
    },
  'Customer JWKS endpoints / Customer JWKS source is down, slow, unreachable, or returns unusable data':
    {
      // Not through a fault proxy: the JWKS fetch accepts only https URLs on
      // public hosts (SSRF guard), so it cannot reach a loopback proxy. These
      // specs inject the failing source instead.
      tests: [
        {
          file: 'src/modules/identity/user-assertions/infrastructure/jwks-key-provider.spec.ts',
          titles: [
            'serves stale keys when a refresh fails within the stale window',
            'returns the contracted unavailable error when there is no usable cache',
            'classifies DNS and network failures as retryable source unavailability',
            'classifies unsupported JWKS content as invalid without echoing it',
            'rejects a response over the 64KB cap before caching it',
            'negatively caches a cold JWKS failure for 30 seconds with a retry hint',
          ],
        },
        {
          file: 'src/modules/identity/user-assertions/application/user-assertion-verifier.spec.ts',
          titles: [
            'answers an unreachable JWKS source with no usable cache as a retryable IDENTITY_PROVIDER_UNAVAILABLE',
          ],
        },
        {
          file: 'test/integration/jwks-dns-isolation.integration.spec.ts',
          titles: [
            'lets Argon2 and another Organization’s downstream hostname connect during a silent JWKS DNS query',
          ],
        },
      ],
      gaps: 'No case proves a hung source is cut at the 3 s fetch timeout. On the assertion path UserAssertionVerifier turns IDENTITY_JWKS_INVALID into retryable 503 IDENTITY_PROVIDER_UNAVAILABLE, while the matrix promises non-retryable 400 IDENTITY_JWKS_INVALID; #372 decides which side moves.',
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
