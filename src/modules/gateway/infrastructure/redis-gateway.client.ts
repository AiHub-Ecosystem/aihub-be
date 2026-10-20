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
  zrem(key: string, member: string): Promise<number>;
  quit(): Promise<unknown>;
}

export const REDIS_GATEWAY_CLIENT = Symbol('REDIS_GATEWAY_CLIENT');

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

  zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  quit(): Promise<unknown> {
    return this.client.quit();
  }
}

export function createRedisGatewayClient(
  url: string,
): RedisGatewayClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = new Redis(url, {
    commandTimeout: 100,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', () => undefined);
  return new IoredisGatewayClient(client);
}
