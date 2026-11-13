import type Redis from 'ioredis';

import { flushOwnedRedisDatabase } from '../../../scripts/checks/db-lane/ownership';
import { createSandboxTestRedis } from './database';

/**
 * A connected sandbox-lane Redis with its database flushed, after the lane
 * ownership marker has been checked. The caller owns `quit()`.
 */
export async function openFlushedSandboxRedis(): Promise<Redis> {
  const redis = createSandboxTestRedis();
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  }
  await flushOwnedRedisDatabase(
    redis.duplicate({ db: 0, enableOfflineQueue: true }),
    () => redis.flushdb(),
    'SANDBOX_TEST_REDIS_URL',
  );
  return redis;
}
