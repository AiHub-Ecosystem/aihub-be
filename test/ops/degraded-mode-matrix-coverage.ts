/**
 * Proof map for docs/superpowers/specs/2026-09-07-aihub/14-degraded-mode-matrix.md.
 *
 * Keys are `<section heading> / <seam and failure cell>` copied from the matrix,
 * so editing a row forces a review of its proof. A few keys name obligations the
 * matrix states in prose rather than in a table row.
 *
 * A `pending` proof or a tested proof with `gaps` names the issue that owns it:
 * #2028 (DNS/IP cutover and recovery bounds), #2029 (matrix/code alignment),
 * or #398 (the heap budget).
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
        {
          file: `${FAULT}lost-keys-fault.spec.ts`,
          titles: [
            'fails a hard-stop Organization closed and admits others as quota_unverified, never reading the lost counter as zero',
            'rebuilds the counter from durable usage once the source returns',
          ],
        },
      ],
    },
  'Redis / Graded concurrency permit is down, slow, ambiguous, or malformed': {
    tests: [
      {
        file: `${FAULT}gateway-redis-fault.spec.ts`,
        titles: [
          'admits a %s Organization request after concurrent outage attempts leave no leases',
          'frees a permit after Redis returns beyond the bounded retry attempts',
        ],
      },
    ],
  },
  'Redis / Post-result quota counter increment fails': {
    tests: [
      {
        file: `${FAULT}quota-counter-fault.spec.ts`,
        titles: [
          'keeps the result and its usage record, marks it quota_unverified, and counts the seam when Redis is %s',
          'counts again once Redis returns',
        ],
      },
      {
        // The counter gap is rebuilt from durable usage, and a hard-stop
        // Organization is still refused at its next admission.
        file: `${FAULT}lost-keys-fault.spec.ts`,
        titles: [
          'rebuilds a lost quota counter from durable usage, once, for concurrent first requests',
          'refuses a hard-stop Organization whose durable usage already meets its quota',
        ],
      },
    ],
  },
  'Redis / Non-graded rate limiter is down or slow': {
    pending:
      'Matrix/code conflict: gateway.module.ts binds RATE_LIMITER to RedisRateLimiter, which fails closed with REDIS_UNAVAILABLE (gateway-redis-fault.spec.ts), and RateLimitGuard has no process-local fallback, while the matrix promises one. #372 decides which side moves; #2029 applies it.',
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
        {
          file: `${FAULT}identity-redis-fault.spec.ts`,
          titles: [
            'spends uncached lookups from a local bucket of 5 per second with burst 5',
            'refuses an IP after 20 failures inside the 300 s local window, then forgets them',
            'keeps at most 10,000 IPs in the local failure map, dropping the oldest',
          ],
        },
      ],
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
      {
        file: `${FAULT}identity-redis-fault.spec.ts`,
        titles: [
          'answers a retryable 503 IDENTITY_PROVIDER_UNAVAILABLE from the JWKS step, before any replay reservation',
        ],
      },
    ],
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
    tests: [
      {
        file: `${FAULT}token-revocation-fault.spec.ts`,
        titles: [
          'commits the revocation and rejects the token everywhere when the publish fails because Redis is %s',
          'keeps rejecting revoked tokens from PostgreSQL while the subscriber is down, and resubscribes once Redis returns',
        ],
      },
      {
        file: 'src/modules/auth/user-access-tokens/infrastructure/bloom-filter/bloom-filter-user-access-token-revocation.adapter.spec.ts',
        titles: ['stops retrying after the attempt bound and says so once'],
      },
    ],
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
      // A wiring check, not a fault case: #2020 (PR #2031) removed the
      // replica target, so there is no replica read left to fault.
      tests: [
        {
          file: 'src/modules/identity/testing/identity.module.spec.ts',
          titles: [
            'uses the writer for durable reads and does not fall back to a replica',
          ],
        },
      ],
    },
  'PostgreSQL / Speaking result-ownership write fails': {
    tests: [
      {
        file: `${FAULT}postgres-result-write-fault.spec.ts`,
        titles: [
          'fails the write as a retryable 503 DATABASE_UNAVAILABLE and records nothing when PostgreSQL is %s',
        ],
      },
      {
        file: 'src/modules/speaking/presentation/speaking-v2.controller.spec.ts',
        titles: [
          'fails closed with retryable DATABASE_UNAVAILABLE when a successful grade cannot be recorded',
          'fails closed without metering when an aggregation at %s cannot be recorded',
        ],
      },
      {
        file: 'src/modules/speaking/application/grading-jobs/process-speaking-grading-job.spec.ts',
        titles: [
          'suppresses metering and fails the job when result ownership recording fails',
        ],
      },
    ],
  },
  'PostgreSQL / Metering write fails after an otherwise successful result': {
    tests: [
      {
        file: `${FAULT}postgres-result-write-fault.spec.ts`,
        titles: [
          'keeps the successful result inside the write bound and counts the lost write when PostgreSQL is %s',
          'records usage again once PostgreSQL returns',
        ],
      },
    ],
    gaps: 'The matrix names aihub_metering_incomplete_total and a durable incomplete outcome for reconciliation. The code counts a lost write in aihub_metering_write_failed_total{reason} and a log line; aihub_metering_incomplete_total counts only missing_usage records, and no durable row marks the lost write (its dispatch attempt reads response_received, so the unresolved-attempt gauge skips it). #372 decides which side moves; #2029 applies it.',
  },
  'PostgreSQL / Audit/UX read uses a replica': {
    // A wiring check, not a fault case: #2020 (PR #2031) removed the
    // replica target, so there is no replica read left to fault.
    tests: [
      {
        file: 'src/modules/identity/testing/identity.module.spec.ts',
        titles: [
          'uses the writer for durable reads and does not fall back to a replica',
        ],
      },
    ],
  },
  'Vault and runtime secrets / Required secret is missing, malformed, or incomplete at startup':
    {
      tests: [
        {
          file: 'src/modules/secrets/infrastructure/configured-runtime-secret.provider.spec.ts',
          titles: [
            'rejects a missing required credential without exposing its value',
            'rejects malformed Agent-rendered data without exposing raw JSON',
            'fails closed when the Agent-rendered file is unavailable',
            'fails closed when the email-outbox key bundle is missing',
          ],
        },
        {
          file: 'test/db/startup/startup-secret-failure.spec.ts',
          titles: [
            'exits with a safe configuration error before listening on %s',
          ],
        },
      ],
    },
  'Vault and runtime secrets / Vault/Agent becomes unavailable after a snapshot is loaded':
    {
      tests: [
        {
          file: 'src/modules/secrets/infrastructure/configured-runtime-secret.provider.spec.ts',
          titles: [
            'keeps serving the loaded snapshot once the Agent-rendered file becomes unreadable',
            'loads an Agent-rendered JSON snapshot and keeps it stable after startup',
          ],
        },
      ],
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
    tests: [
      {
        file: 'test/integration/object-storage-deadlines.spec.ts',
        titles: ['uses the %s budget without automatic retries'],
      },
      {
        file: 'test/db/writing/writing-chart-upload-sweep.spec.ts',
        titles: [
          'keeps the row of an object storage could not delete mid-run, and deletes it on the next run',
        ],
      },
    ],
  },
  // Not through a fault proxy: the sender posts to Resend's fixed HTTPS
  // endpoint, so provider answers are injected at its fetch seam and the
  // shared circuit runs against the lane Redis.
  'Email provider / Resend returns 429/5xx, times out, or transport fails': {
    tests: [
      {
        file: 'src/modules/auth/email-delivery/application/poller/email-delivery-poller.dispatch.spec.ts',
        titles: [
          'refunds an attempt and pauses the rest of the batch after a provider-wide 5xx',
          'defers 429 without spending an attempt and honours Retry-After',
          'does not reserve a send or spend an attempt while the shared circuit is open',
          'reports an attempt timeout as its own error code',
        ],
      },
      {
        file: 'src/modules/auth/email-delivery/infrastructure/resend/resend-email.sender.spec.ts',
        titles: [
          'classifies a fetch rejection without retaining the thrown error',
        ],
      },
      {
        file: 'src/modules/auth/email-delivery/infrastructure/redis-rate-limiter/redis-email-send-rate-limiter.spec.ts',
        titles: [
          'applies Redis full-jitter backoff while keeping Retry-After as a minimum',
        ],
      },
      {
        file: 'test/db/auth/email-provider-outage-circuit.spec.ts',
        titles: [
          'preserves the longest cooldown and allows one shared half-open probe',
        ],
      },
      {
        file: 'src/modules/auth/email-delivery/infrastructure/metrics/email-delivery-metrics.spec.ts',
        titles: ['exposes shared outage duration in seconds without labels'],
      },
    ],
  },
  'Email provider / Resend returns credential 401/403': {
    tests: [
      {
        file: 'src/modules/auth/email-delivery/application/poller/email-delivery-poller.dispatch.spec.ts',
        titles: ['holds the queue and emits one configuration alert for %s'],
      },
      {
        file: 'src/modules/auth/email-delivery/infrastructure/email-outbox-poller.scheduler.spec.ts',
        titles: ['emits a bounded configuration signal for status %s'],
      },
    ],
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
          file: 'src/modules/gateway/infrastructure/ai-service-response-fault.spec.ts',
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
          file: 'src/modules/gateway/infrastructure/ai-service-response-fault.spec.ts',
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
          file: 'src/modules/gateway/infrastructure/ai-service-response-fault.spec.ts',
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
        {
          file: 'src/modules/identity/user-assertions/infrastructure/jwks-remote-fetch.spec.ts',
          titles: [
            'gives up at the 3 s fetch deadline with a retryable IDENTITY_JWKS_SOURCE_UNAVAILABLE',
          ],
        },
      ],
      gaps: 'On the assertion path UserAssertionVerifier turns IDENTITY_JWKS_INVALID into retryable 503 IDENTITY_PROVIDER_UNAVAILABLE, while the matrix promises non-retryable 400 IDENTITY_JWKS_INVALID; #372 decides which side moves; #2029 applies it.',
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
    gaps: 'RECOVERY_BOUND_MS (10 s) is provisional; #2028 replaces it with the same-process recovery bounds #749 and #645 select.',
  },
  [PROSE_OBLIGATIONS[1]]: {
    pending:
      'No DNS cutover case yet; #2028 owns it, blocked by #749 and #645.',
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
