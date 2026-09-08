import { Logger } from '@nestjs/common';

import type {
  ConcurrencyDecision,
  ConcurrencyLease,
  ConcurrencyLimiterPort,
  ConcurrencyRequest,
} from '../application/concurrency-limiter.port';
import type { RedisGatewayClient } from './redis-gateway.client';

export type RedisConcurrencyClient = Pick<
  RedisGatewayClient,
  'eval' | 'zrem' | 'quit'
>;

export const CONCURRENCY_RETRY_AFTER_MS = 500;
export const CONCURRENCY_STALE_LEASE_MS = 120_000;
export const GLOBAL_MAX_INFLIGHT = 200;

export const ACQUIRE_CONCURRENCY_SCRIPT = `
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms - tonumber(ARGV[3]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], now_ms, ARGV[2])
return 1
`;

interface FallbackLease {
  readonly startedAt: number;
}

interface LoggerLike {
  warn(message: string): void;
  log(message: string): void;
}

function denied(): ConcurrencyDecision {
  return { allowed: false, retryAfterMs: CONCURRENCY_RETRY_AFTER_MS };
}

export class RedisConcurrencyLimiter implements ConcurrencyLimiterPort {
  private readonly fallbackLeases = new Map<string, FallbackLease>();
  private redisIsDegraded = false;

  constructor(
    private readonly client: RedisConcurrencyClient | undefined,
    private readonly now: () => number = () => Date.now(),
    private readonly logger: LoggerLike = new Logger(
      RedisConcurrencyLimiter.name,
    ),
  ) {}

  async acquire(request: ConcurrencyRequest): Promise<ConcurrencyDecision> {
    if (
      !Number.isInteger(request.maxConcurrent) ||
      request.maxConcurrent <= 0
    ) {
      return denied();
    }

    if (this.client === undefined) {
      return this.acquireFallback(request);
    }

    const key = `aihub:v1:inflight:${request.organizationId}`;
    try {
      const result = await this.client.eval(
        ACQUIRE_CONCURRENCY_SCRIPT,
        1,
        key,
        String(request.maxConcurrent),
        request.requestId,
        String(CONCURRENCY_STALE_LEASE_MS),
      );
      if (result === 0) {
        this.reportRecovered();
        return denied();
      }
      if (result !== 1) {
        throw new Error('Redis concurrency response is invalid');
      }

      this.reportRecovered();
      return {
        allowed: true,
        lease: this.remoteLease(key, request.requestId),
      };
    } catch (error) {
      this.reportDegraded(error);
      return this.acquireFallback(request);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private remoteLease(key: string, requestId: string): ConcurrencyLease {
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await this.client?.zrem(key, requestId);
          this.reportRecovered();
        } catch (error) {
          this.reportDegraded(error);
        }
      },
    };
  }

  private acquireFallback(request: ConcurrencyRequest): ConcurrencyDecision {
    const now = this.now();
    this.pruneFallbackLeases(now);
    if (this.fallbackLeases.size >= GLOBAL_MAX_INFLIGHT) {
      return denied();
    }

    const lease = { startedAt: now };
    this.fallbackLeases.set(request.requestId, lease);
    let released = false;
    return {
      allowed: true,
      lease: {
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          if (this.fallbackLeases.get(request.requestId) === lease) {
            this.fallbackLeases.delete(request.requestId);
          }
        },
      },
    };
  }

  private pruneFallbackLeases(now: number): void {
    const threshold = now - CONCURRENCY_STALE_LEASE_MS;
    for (const [requestId, lease] of this.fallbackLeases) {
      if (lease.startedAt <= threshold) {
        this.fallbackLeases.delete(requestId);
      }
    }
  }

  private reportDegraded(error: unknown): void {
    if (this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Redis concurrency limiter unreachable (${reason}); falling back to a process-local ceiling until it recovers`,
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = false;
    this.logger.log('Redis concurrency limiter recovered');
  }
}
