import Redis from 'ioredis';

import { createRedisClient } from '@/common/redis/create-redis-client';
import { numberReply } from '@/common/redis/number-reply';

export interface RedisIdentityClient {
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<unknown>;
}

class IoredisIdentityClient implements RedisIdentityClient {
  constructor(private readonly client: Redis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<unknown> {
    return condition === undefined
      ? this.client.set(key, value, mode, seconds)
      : this.client.set(key, value, mode, seconds, condition);
  }

  del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    return this.client.eval(script, numberOfKeys, ...args).then(numberReply);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  // A quit that cannot reach Redis leaves ioredis reconnecting, which keeps
  // a shutting-down process alive; drop the connection instead.
  quit(): Promise<unknown> {
    return this.client.quit().catch(() => this.client.disconnect());
  }
}

// docs/operations/redis-round-trip.md: at least three times the measured p95
// round trip to Redis, rounded up to 100 ms.
const REDIS_COMMAND_TIMEOUT_MS = 400;

export function connectRedisIdentityClient(
  url: string,
): RedisIdentityClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = createRedisClient(url, {
    commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
  });
  return new IoredisIdentityClient(client);
}
