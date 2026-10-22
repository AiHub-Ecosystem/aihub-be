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

export function numbers(result: unknown): readonly number[] {
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
    return this.client.eval(script, numberOfKeys, ...args).then((result) => {
      if (typeof result !== 'number') {
        throw new Error('Redis command result is invalid');
      }
      return result;
    });
  }

  evalNumbers(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<readonly number[]> {
    return this.client.eval(script, numberOfKeys, ...args).then(numbers);
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

export function createRedisGatewayClient(
  url: string,
): RedisGatewayClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = new Redis(url, {
    // Calibrated 2026-10-21 from Production app to remote Redis: ready p99 265.537 ms (100 samples), PING p99 71.184 ms (1,000).
    connectTimeout: 1_000,
    commandTimeout: 200,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  client.on('error', () => undefined);
  return new IoredisGatewayClient(client);
}
