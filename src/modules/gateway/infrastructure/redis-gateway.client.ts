import { createRedisClient } from '@/common/redis/create-redis-client';
import { numberReply } from '@/common/redis/number-reply';
import Redis from 'ioredis';

export interface RedisGatewayClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number>;
  /** For a script that returns an array of integers. */
  evalNumbers(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<readonly number[]>;
  zrem(key: string, member: string): Promise<number>;
  quit(): Promise<unknown>;
}

export const REDIS_GATEWAY_CLIENT = Symbol('REDIS_GATEWAY_CLIENT');

/** An `EVAL` reply that must be an array of integers; anything else throws. */
export function integerArrayReply(result: unknown): readonly number[] {
  if (
    !Array.isArray(result) ||
    !result.every((item): item is number => typeof item === 'number')
  ) {
    throw new Error('Redis command result is invalid');
  }
  return result;
}

class IoredisGatewayClient implements RedisGatewayClient {
  constructor(private readonly client: Redis) {}

  ping(): Promise<string> {
    return this.client.ping();
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<string | null> {
    return this.client.set(key, value, mode, seconds);
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    return this.client.eval(script, numberOfKeys, ...args).then(numberReply);
  }

  evalNumbers(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<readonly number[]> {
    return this.client
      .eval(script, numberOfKeys, ...args)
      .then(integerArrayReply);
  }

  zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  // A quit that cannot reach Redis leaves ioredis reconnecting, which keeps
  // a shutting-down process alive; drop the connection instead.
  quit(): Promise<unknown> {
    return this.client.quit().catch(() => this.client.disconnect());
  }
}

// docs/operations/redis-round-trip.md: at least three times the measured p95
// round trip to Redis, rounded up to 100 ms. Re-measured 2026-10-23: p95 108 ms.
export const REDIS_COMMAND_TIMEOUT_MS = 400;

export function createRedisGatewayClient(
  url: string,
): RedisGatewayClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = createRedisClient(url, {
    // Calibrated 2026-10-21 from Production app to remote Redis: ready p99 265.537 ms (100 samples), PING p99 71.184 ms (1,000).
    connectTimeoutMs: 1_000,
    commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
    autoResendUnfulfilledCommands: false,
  });
  return new IoredisGatewayClient(client);
}
