import {
  REDIS_NO_REPLAY_OPTIONS,
  createRedisClient,
} from '@/common/redis/create-redis-client';
import { numberReply } from '@/common/redis/number-reply';
import type Redis from 'ioredis';

/**
 * Narrow client for the quota counter, seeder, and reconciliation counter.
 * Only the commands they use; Metering's own connection so it never imports
 * Gateway to reach a client (#1576).
 */
export interface RedisMeteringClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<string | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number>;
  quit(): Promise<unknown>;
}

export const REDIS_METERING_CLIENT = Symbol('REDIS_METERING_CLIENT');

class IoredisMeteringClient implements RedisMeteringClient {
  constructor(private readonly client: Redis) {}

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

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    return this.client.eval(script, numberOfKeys, ...args).then(numberReply);
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

export function createRedisMeteringClient(
  url: string,
): RedisMeteringClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = createRedisClient(url, {
    commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
    ...REDIS_NO_REPLAY_OPTIONS,
  });
  return new IoredisMeteringClient(client);
}
