import { Logger } from '@nestjs/common';

import type {
  RateLimitDecision,
  RateLimitRequest,
  RateLimiterPort,
} from '@/modules/gateway/application/rate-limiter.port';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './redis-gateway.client';

export type RedisRateLimitClient = Pick<
  RedisGatewayClient,
  'incr' | 'expire' | 'quit'
>;

interface FallbackWindow {
  readonly windowStart: number;
  count: number;
}

export class RedisRateLimiter implements RateLimiterPort {
  private readonly client: RedisRateLimitClient | undefined;
  private readonly now: () => number;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;

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
  ) {
    this.client = client ?? createRedisGatewayClient(url);
    this.now = now;
    this.logger = logger;
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    if (this.client === undefined) {
      return this.consumeFallback(request);
    }

    const minute = Math.floor(this.now() / 60_000);
    const bucket = `aihub:v1:rl:${request.keyId}:${minute}`;
    let count: number;
    try {
      count = await this.client.incr(bucket);
      if (count === 1) {
        await this.client.expire(bucket, 120).catch(() => undefined);
      }
    } catch (error) {
      this.reportDegraded(error);
      return this.consumeFallback(request);
    }

    this.reportRecovered();

    if (count <= request.limit) {
      return { allowed: true };
    }

    return this.rejection();
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
    const minute = Math.floor(this.now() / 60_000);
    const existing = this.fallbackWindows.get(request.keyId);
    const count =
      existing !== undefined && existing.windowStart === minute
        ? existing.count + 1
        : 1;
    this.fallbackWindows.set(request.keyId, { windowStart: minute, count });
    this.pruneStaleFallbackWindows(minute);

    return count <= request.limit ? { allowed: true } : this.rejection();
  }

  /** Keeps the fallback map from growing for the lifetime of an outage. */
  private pruneStaleFallbackWindows(currentMinute: number): void {
    for (const [keyId, window] of this.fallbackWindows) {
      if (window.windowStart !== currentMinute) {
        this.fallbackWindows.delete(keyId);
      }
    }
  }

  private rejection(): RateLimitDecision {
    const elapsed = this.now() % 60_000;
    return { allowed: false, retryAfterMs: Math.max(1, 60_000 - elapsed) };
  }
}
