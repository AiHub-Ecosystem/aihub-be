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

const redisUnavailableTotal = new Counter({
  name: 'aihub_redis_unavailable_total',
  help: 'Redis commands a request-path protection seam could not complete, by seam.',
  labelNames: ['seam'],
  registers: [registry],
});

// A series that first appears at 1 has no earlier sample, so `increase()`
// reads the first unavailable answer after a restart as 0 and an alert on it
// stays silent. The email send-rate seam is exposed at 0 for that alert; the
// request-path seams keep appearing on their first answer.
redisUnavailableTotal.inc(
  { seam: 'email_send_rate' satisfies RedisProtectionSeam },
  0,
);

export function recordRedisUnavailable(seam: RedisProtectionSeam): void {
  try {
    redisUnavailableTotal.inc({ seam });
  } catch {
    // An observability failure must not change the seam's outage policy.
  }
}
