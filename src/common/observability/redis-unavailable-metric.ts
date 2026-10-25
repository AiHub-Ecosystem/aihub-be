import { Counter } from '@prometheus-io/client';

import { registry } from './metrics';

/** Every request-path seam that keeps protection state in Redis (#200, #328). */
export type RedisProtectionSeam =
  | 'graded_admission'
  | 'concurrency'
  | 'rate_limit'
  | 'quota'
  | 'retry_budget'
  | 'api_key_cache'
  | ApiKeyCacheInvalidationSeam
  | 'auth_failure_counter'
  | 'auth_rate_limit'
  | 'jwks_cache'
  | 'email_send_rate';

export type ApiKeyCacheInvalidationSeam =
  | 'api_key_cache_invalidation_revoke'
  | 'api_key_cache_invalidation_rotate'
  | 'api_key_cache_invalidation_suspension';

const REDIS_PROTECTION_SEAMS = [
  'graded_admission',
  'concurrency',
  'rate_limit',
  'quota',
  'retry_budget',
  'api_key_cache',
  'api_key_cache_invalidation_revoke',
  'api_key_cache_invalidation_rotate',
  'api_key_cache_invalidation_suspension',
  'auth_failure_counter',
  'auth_rate_limit',
  'jwks_cache',
  'email_send_rate',
] as const satisfies readonly RedisProtectionSeam[];

const redisUnavailableTotal = new Counter({
  name: 'aihub_redis_unavailable_total',
  help: 'Redis commands an AIHUB protection or cache seam could not complete, by seam.',
  labelNames: ['seam'],
  registers: [registry],
});

// A zero sample lets Prometheus detect the first failure after a process restart.
for (const seam of REDIS_PROTECTION_SEAMS)
  redisUnavailableTotal.inc({ seam }, 0);

export function recordRedisUnavailable(seam: RedisProtectionSeam): void {
  try {
    redisUnavailableTotal.inc({ seam });
  } catch {
    // An observability failure must not change the seam's outage policy.
  }
}
