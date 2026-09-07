import Redis from 'ioredis';

import type {
  RateLimitDecision,
  RateLimitRequest,
  RateLimiterPort,
} from '../application/rate-limiter.port';

export interface RedisRateLimitClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<unknown>;
}

class IoredisRateLimitClient implements RedisRateLimitClient {
  constructor(private readonly client: Redis) {}

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  quit(): Promise<unknown> {
    return this.client.quit();
  }
}

function connect(url: string): RedisRateLimitClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = new Redis(url, {
    commandTimeout: 100,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', () => undefined);
  return new IoredisRateLimitClient(client);
}

export class RedisRateLimiter implements RateLimiterPort {
  private readonly client: RedisRateLimitClient | undefined;
  private readonly now: () => number;

  constructor(
    url: string,
    client?: RedisRateLimitClient,
    now: () => number = () => Date.now(),
  ) {
    this.client = client ?? connect(url);
    this.now = now;
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    if (this.client === undefined) {
      return { allowed: true };
    }

    const minute = Math.floor(this.now() / 60_000);
    const bucket = `aihub:v1:rl:${request.keyId}:${minute}`;
    let count: number;
    try {
      count = await this.client.incr(bucket);
      if (count === 1) {
        await this.client.expire(bucket, 120).catch(() => undefined);
      }
    } catch {
      return { allowed: true };
    }

    if (count <= request.limit) {
      return { allowed: true };
    }

    const elapsed = this.now() % 60_000;
    return {
      allowed: false,
      retryAfterMs: Math.max(1, 60_000 - elapsed),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
