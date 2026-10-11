import {
  INCREMENT_WITH_EXPIRY_SCRIPT,
  type RedisScriptEvaluator,
  incrementRedisCounterWithExpiry,
} from './increment-with-expiry';

describe('incrementRedisCounterWithExpiry', () => {
  it('sets or repairs the TTL before incrementing in one script', () => {
    const missingKeyExpiry = INCREMENT_WITH_EXPIRY_SCRIPT.indexOf(
      "redis.call('SET', KEYS[1], '0', 'EX', ARGV[1])",
    );
    const existingKeyExpiry = INCREMENT_WITH_EXPIRY_SCRIPT.indexOf(
      "redis.call('EXPIRE', KEYS[1], ARGV[1])",
    );
    const increment = INCREMENT_WITH_EXPIRY_SCRIPT.indexOf(
      "redis.call('INCR', KEYS[1])",
    );

    expect(missingKeyExpiry).toBeGreaterThanOrEqual(0);
    expect(existingKeyExpiry).toBeGreaterThanOrEqual(0);
    expect(missingKeyExpiry).toBeLessThan(increment);
    expect(existingKeyExpiry).toBeLessThan(increment);
  });

  it('passes one key and the configured TTL to a single Redis evaluation', async () => {
    const evaluate: RedisScriptEvaluator = jest.fn().mockResolvedValue(3);

    await expect(
      incrementRedisCounterWithExpiry(evaluate, 'aihub:v1:rl:key:1', 120),
    ).resolves.toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      INCREMENT_WITH_EXPIRY_SCRIPT,
      1,
      'aihub:v1:rl:key:1',
      120,
    );
  });

  it('rejects invalid TTLs before contacting Redis', async () => {
    const evaluate: RedisScriptEvaluator = jest.fn();

    await expect(
      incrementRedisCounterWithExpiry(evaluate, 'counter', 0),
    ).rejects.toThrow('Redis counter TTL is invalid');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
