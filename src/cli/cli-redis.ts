import Redis from 'ioredis';

import {
  apiKeyCacheKey,
  apiKeyCacheMissKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';

/**
 * The one Redis connection every operator command opens: bounded timeouts, no
 * offline queue and no retry loop, so a dead Redis fails the command in seconds
 * instead of hanging it. The socket is closed when the connect fails.
 */
export async function connectCliRedis(url: string): Promise<Redis> {
  const redis = new Redis(url, {
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  return redis;
}

/** Drops the cached lookup and miss entries for each API-key hash. */
export async function purgeApiKeyCache(
  redisUrl: string,
  keyHashes: readonly string[],
): Promise<void> {
  if (keyHashes.length === 0) {
    return;
  }
  const redis = await connectCliRedis(redisUrl);
  try {
    await redis.del(
      ...keyHashes.flatMap((hash) => [
        apiKeyCacheKey(hash),
        apiKeyCacheMissKey(hash),
      ]),
    );
  } finally {
    redis.disconnect();
  }
}
