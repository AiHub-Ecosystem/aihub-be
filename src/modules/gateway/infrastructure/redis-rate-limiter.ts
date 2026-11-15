import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';
import { incrementRedisCounterWithExpiry } from '@/common/redis/increment-with-expiry';
import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import {
  rateLimitDecision,
  rateLimitWindow,
} from '@/modules/gateway/application/rate-limit-window';
import type {
  RateLimitDecision,
  RateLimitRequest,
  RateLimiterPort,
} from '@/modules/gateway/application/rate-limiter.port';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './redis-gateway.client';

/** One counter per API key and window, shared with graded admission. */
export function rateLimitKey(keyId: string, windowIndex: number): string {
  return `aihub:v1:rl:${keyId}:${windowIndex}`;
}

export type RedisRateLimitClient = Pick<RedisGatewayClient, 'eval' | 'quit'>;

export class RedisRateLimiter implements RateLimiterPort {
  private readonly client: RedisRateLimitClient | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly health: RedisHealthReporter;

  constructor(
    url: string,
    client?: RedisRateLimitClient,
    now: () => number = () => Date.now(),
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(RedisRateLimiter.name),
    random: () => number = Math.random,
  ) {
    this.client = client ?? createRedisGatewayClient(url);
    this.now = now;
    this.random = random;
    this.health = new RedisHealthReporter(
      'rate_limit',
      'rate limiter',
      logger,
      'refusing requests until it recovers',
    );
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const client = this.client;
    if (client === undefined) {
      this.health.reportDegraded();
      throw this.unavailableError();
    }

    const window = rateLimitWindow(request.keyId, this.now());
    const bucket = rateLimitKey(request.keyId, window.index);
    let count: number;
    try {
      count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        bucket,
        120,
      );
    } catch (error) {
      this.health.reportDegraded(error);
      throw this.unavailableError(error);
    }

    this.health.reportRecovered();
    return rateLimitDecision(request.limit, count, window, this.random);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private unavailableError(cause?: unknown): AppError {
    return new AppError({
      code: 'REDIS_UNAVAILABLE',
      message: 'Rate-limit controls are temporarily unavailable',
      retryable: true,
      retryAfterMs: outageRetryAfterMs(this.random),
      diagnostic: 'rate-limit-redis-unavailable',
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
