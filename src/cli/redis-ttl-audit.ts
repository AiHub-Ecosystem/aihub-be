import Redis from 'ioredis';

const AIHUB_KEY_SCAN_COUNT = 250;
const JWKS_GENERATION_PREFIX = 'aihub:v1:jwks-generation:';

export interface RedisTtlAuditClient {
  scan(cursor: string): Promise<[string, string[]]>;
  getTtls(keys: readonly string[]): Promise<readonly number[]>;
  quit(): Promise<unknown>;
}

export interface RedisTtlAuditSummary {
  readonly scanHits: number;
  readonly missingTtl: number;
  readonly intentionallyPersistent: number;
}

interface RedisTtlAuditInput {
  readonly redisUrl: string;
  readonly client?: RedisTtlAuditClient;
  readonly emit?: (line: string) => void;
}

async function connectRedis(url: string): Promise<RedisTtlAuditClient> {
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

  return {
    scan: (cursor) =>
      redis.scan(cursor, 'MATCH', 'aihub:*', 'COUNT', AIHUB_KEY_SCAN_COUNT),
    getTtls: async (keys) => {
      if (keys.length === 0) {
        return [];
      }

      const pipeline = redis.pipeline();
      for (const key of keys) {
        pipeline.ttl(key);
      }
      const replies = await pipeline.exec();
      if (replies === null || replies.length !== keys.length) {
        throw new Error('Redis TTL audit returned an invalid result');
      }
      return replies.map(([error, ttl]) => {
        if (error !== null || typeof ttl !== 'number') {
          throw new Error('Redis TTL audit failed');
        }
        return ttl;
      });
    },
    quit: async () => {
      await redis.quit().catch(() => undefined);
      redis.disconnect();
    },
  };
}

export async function runRedisTtlAuditCommand(
  input: RedisTtlAuditInput,
): Promise<RedisTtlAuditSummary> {
  if (input.redisUrl.trim().length === 0) {
    throw new Error('REDIS_URL is required');
  }

  const client = input.client ?? (await connectRedis(input.redisUrl));
  const emit = input.emit ?? console.log;
  let cursor = '0';
  let scanHits = 0;
  let missingTtl = 0;
  let intentionallyPersistent = 0;

  try {
    do {
      const [nextCursor, keys] = await client.scan(cursor);
      if (!/^\d+$/.test(nextCursor)) {
        throw new Error('Redis TTL audit returned an invalid cursor');
      }
      const ttls = await client.getTtls(keys);
      if (ttls.length !== keys.length) {
        throw new Error('Redis TTL audit returned an invalid result');
      }

      // shortcut: count SCAN hits without deduplication; this check only alerts on nonzero findings, add a bounded inventory if exact totals are needed.
      scanHits += keys.length;
      for (const [index, ttl] of ttls.entries()) {
        if (!Number.isInteger(ttl) || ttl < -2) {
          throw new Error('Redis TTL audit returned an invalid TTL');
        }
        if (ttl !== -1) {
          continue;
        }

        // This persistent generation fence prevents a purged JWKS cache entry from becoming current again.
        if (keys[index]?.startsWith(JWKS_GENERATION_PREFIX)) {
          intentionallyPersistent += 1;
        } else {
          missingTtl += 1;
        }
      }
      cursor = nextCursor;
    } while (cursor !== '0');

    const summary = { scanHits, missingTtl, intentionallyPersistent };
    emit(
      JSON.stringify({
        event: 'redis_ttl_audit',
        scan_hits: scanHits,
        missing_ttl: missingTtl,
        intentionally_persistent: intentionallyPersistent,
        status: missingTtl === 0 ? 'ok' : 'failed',
      }),
    );
    return summary;
  } finally {
    await client.quit().catch(() => undefined);
  }
}
