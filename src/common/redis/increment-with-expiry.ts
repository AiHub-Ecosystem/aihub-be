export type RedisScriptEvaluator = (
  script: string,
  numberOfKeys: number,
  ...args: readonly (string | number)[]
) => Promise<number>;

export const INCREMENT_WITH_EXPIRY_SCRIPT = `
local ttl = redis.call('TTL', KEYS[1])
if ttl == -2 then
  redis.call('SET', KEYS[1], '0', 'EX', ARGV[1])
elseif ttl == -1 then
  local expiry_set = redis.call('EXPIRE', KEYS[1], ARGV[1])
  if expiry_set ~= 1 then
    return redis.error_reply('counter TTL was not set')
  end
end
return redis.call('INCR', KEYS[1])
`;

export async function incrementRedisCounterWithExpiry(
  evaluate: RedisScriptEvaluator,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Redis counter TTL is invalid');
  }

  const count = await evaluate(
    INCREMENT_WITH_EXPIRY_SCRIPT,
    1,
    key,
    ttlSeconds,
  );
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Redis counter result is invalid');
  }
  return count;
}
