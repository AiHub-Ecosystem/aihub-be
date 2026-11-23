import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { internalError } from '@/common/errors/app-error';
import {
  REDIS_NO_REPLAY_OPTIONS,
  createRedisClient,
} from '@/common/redis/create-redis-client';
import { numberReply } from '@/common/redis/number-reply';
import Redis from 'ioredis';

export interface RedisGatewayClient {
  waitUntilReady(signal: AbortSignal): Promise<boolean>;
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

@Injectable()
export class RedisGatewayClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_GATEWAY_CLIENT)
    private readonly client: Pick<RedisGatewayClient, 'quit'> | undefined,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}

/** An `EVAL` reply that must be an array of integers; anything else throws. */
export function integerArrayReply(result: unknown): readonly number[] {
  if (
    !Array.isArray(result) ||
    !result.every((item): item is number => typeof item === 'number')
  ) {
    throw internalError('Redis command result is invalid');
  }
  return result;
}

class IoredisGatewayClient implements RedisGatewayClient {
  constructor(private readonly client: Redis) {}

  waitUntilReady(signal: AbortSignal): Promise<boolean> {
    if (this.client.status === 'ready') return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        this.client.removeListener('ready', onReady);
        signal.removeEventListener('abort', onAbort);
        resolve(ready);
      };
      const onReady = (): void => finish(true);
      const onAbort = (): void => finish(false);

      this.client.once('ready', onReady);
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.client.status === 'ready') onReady();
    });
  }

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
    commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
    ...REDIS_NO_REPLAY_OPTIONS,
  });
  return new IoredisGatewayClient(client);
}
