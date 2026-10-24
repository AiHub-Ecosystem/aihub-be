import type { ApiKeyCacheInvalidationSeam } from '@/common/observability/redis-unavailable-metric';

export type OperatorRedisFailureSeam =
  | ApiKeyCacheInvalidationSeam
  | 'api_key_cache';

export interface OperatorRedisFailurePort {
  recordFailure(seam: OperatorRedisFailureSeam): Promise<void>;
}
