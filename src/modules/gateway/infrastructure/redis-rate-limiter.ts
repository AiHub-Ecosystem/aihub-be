import { Logger } from '@nestjs/common';

import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import { incrementRedisCounterWithExpiry } from '@/common/redis/increment-with-expiry';
import {
  type RateLimitWindow,
  rateLimitWindow,
} from '@/modules/gateway/application/rate-limit-window';
import type {
  RateLimitDecision,
  RateLimitRequest,
  RateLimiterPort,
} from '@/modules/gateway/application/rate-limiter.port';
import { jitteredRetryAfterMs } from '@/modules/gateway/application/retry-hint';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './redis-gateway.client';

export type RedisRateLimitClient = Pick<RedisGatewayClient, 'eval' | 'quit'>;

interface FallbackWindow {
  readonly windowStart: number;
  count: number;
}

export class RedisRateLimiter implements RateLimiterPort {
  private readonly client: RedisRateLimitClient | undefined;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;
  private readonly random: () => number;

  // ponytail: a process-local, single-instance approximation of the same
  // per-minute limit, only ever consulted while Redis is unreachable. It is
  // not shared across replicas and resets on restart — a coarse backstop so
  // an outage means "capped at roughly the configured limit per instance",
  // not "unlimited", never a substitute for the real distributed counter.
  private readonly fallbackWindows = new Map<string, FallbackWindow>();
  private redisIsDegraded = false;

  constructor(
    url: string,
    client?: RedisRateLimitClient,
    now: () => number = () => Date.now(),
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(RedisRateLimiter.name),
    random: () => number = Math.random,
  ) {
    this.client = client ?? createRedisGatewayClient(url);
    this.now = now;
    this.logger = logger;
    this.random = random;
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const client = this.client;
    if (client === undefined) {
      return this.consumeFallback(request);
    }

    const window = rateLimitWindow(request.keyId, this.now());
    const bucket = `aihub:v1:rl:${request.keyId}:${window.index}`;
    let count: number;
    try {
      count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        bucket,
        120,
      );
    } catch (error) {
      this.reportDegraded(error);
      return this.consumeFallback(request);
    }

    this.reportRecovered();
    return this.decide(request, count, window);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  /**
   * Fires once per outage, not once per request: at any real RPS, logging on
   * every failed command during an actual Redis outage would flood the log
   * with an identical line rather than alert on anything.
   */
  private reportDegraded(error: unknown): void {
    recordRedisUnavailable('rate_limit');
    if (this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Redis rate limiter unreachable (${reason}); falling back to a process-local ceiling until it recovers`,
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = false;
    this.logger.log('Redis rate limiter recovered');
  }

  private consumeFallback(request: RateLimitRequest): RateLimitDecision {
    const window = rateLimitWindow(request.keyId, this.now());
    const existing = this.fallbackWindows.get(request.keyId);
    const count =
      existing !== undefined && existing.windowStart === window.index
        ? existing.count + 1
        : 1;
    this.fallbackWindows.set(request.keyId, {
      windowStart: window.index,
      count,
    });
    this.pruneStaleFallbackWindows(window.index);

    return this.decide(request, count, window);
  }

  /** Keeps the fallback map from growing for the lifetime of an outage. */
  private pruneStaleFallbackWindows(currentMinute: number): void {
    for (const [keyId, window] of this.fallbackWindows) {
      if (window.windowStart !== currentMinute) {
        this.fallbackWindows.delete(keyId);
      }
    }
  }

  private decide(
    request: RateLimitRequest,
    count: number,
    window: RateLimitWindow,
  ): RateLimitDecision {
    const standing = {
      limit: request.limit,
      remaining: Math.max(0, request.limit - count),
      resetInMs: window.resetInMs,
    };
    return count <= request.limit
      ? { allowed: true, standing }
      : {
          allowed: false,
          retryAfterMs: jitteredRetryAfterMs(window.resetInMs, this.random),
          standing,
        };
  }
}
