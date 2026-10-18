import Redis, { type CommonRedisOptions } from 'ioredis';

export const SANDBOX_REDIS_KEY_PREFIX = 'aihub-sandbox:';
const KEY_PREFIX_QUERY_PARAMETER = 'keyPrefix';
type RedisClientOptions = Omit<CommonRedisOptions, 'replyMapping'>;

/** Creates an ioredis boundary client and applies an optional URL key namespace. */
export function createConfiguredRedisClient(
  url: string,
  options: RedisClientOptions = {},
): Redis {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Redis URL is invalid');
  }

  const prefixes = parsed.searchParams.getAll(KEY_PREFIX_QUERY_PARAMETER);
  if (prefixes.length === 0) {
    return new Redis(url, options);
  }
  const keyPrefix = prefixes[0];
  if (
    prefixes.length !== 1 ||
    keyPrefix === undefined ||
    keyPrefix.length === 0 ||
    (options.keyPrefix !== undefined && options.keyPrefix !== keyPrefix)
  ) {
    throw new Error('Redis URL keyPrefix is invalid');
  }

  parsed.searchParams.delete(KEY_PREFIX_QUERY_PARAMETER);

  return new Redis(parsed.toString(), {
    ...options,
    enableReadyCheck:
      keyPrefix === SANDBOX_REDIS_KEY_PREFIX ? false : options.enableReadyCheck,
    keyPrefix,
  });
}
