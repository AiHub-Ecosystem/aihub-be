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
  | 'auth_failure_counter'
  | 'auth_rate_limit'
  | 'jwks_cache';

const redisUnavailableTotal = new Counter({
  name: 'aihub_redis_unavailable_total',
  help: 'Redis commands a request-path protection seam could not complete, by seam.',
  labelNames: ['seam'],
  registers: [registry],
});

export function recordRedisUnavailable(seam: RedisProtectionSeam): void {
  try {
    redisUnavailableTotal.inc({ seam });
  } catch {
    // An observability failure must not change the seam's outage policy.
  }
}
