import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import type {
  ConcurrencyDecision,
  ConcurrencyLease,
  ConcurrencyLimiterPort,
  ConcurrencyRequest,
} from '@/modules/gateway/application/concurrency-limiter.port';
import type { RedisGatewayClient } from './redis-gateway.client';

export type RedisConcurrencyClient = Pick<
  RedisGatewayClient,
  'eval' | 'zrem' | 'quit'
>;

export const CONCURRENCY_RETRY_AFTER_MS = 500;
export const CONCURRENCY_STALE_LEASE_MS = 120_000;
const UNAVAILABLE_RETRY_AFTER_MS = 1_000;

export const ACQUIRE_CONCURRENCY_SCRIPT = `
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local stale_ms = tonumber(ARGV[3])
local ttl_seconds = math.ceil(stale_ms / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms - stale_ms)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ttl_seconds)
  return 0
end
redis.call('ZADD', KEYS[1], now_ms, ARGV[2])
redis.call('EXPIRE', KEYS[1], ttl_seconds)
return 1
`;

export const ACQUIRE_SANDBOX_CONCURRENCY_SCRIPT = `
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local stale_ms = tonumber(ARGV[4])
local ttl_seconds = math.ceil(stale_ms / 1000)
for i = 1, 2 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now_ms - stale_ms)
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) or
   redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ttl_seconds)
  redis.call('EXPIRE', KEYS[2], ttl_seconds)
  return 0
end
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now_ms, ARGV[3])
  redis.call('EXPIRE', KEYS[i], ttl_seconds)
end
return 1
`;

interface LoggerLike {
  warn(message: string): void;
  log(message: string): void;
}

function denied(): ConcurrencyDecision {
  return { allowed: false, retryAfterMs: CONCURRENCY_RETRY_AFTER_MS };
}

export class RedisConcurrencyLimiter implements ConcurrencyLimiterPort {
  private redisIsDegraded = false;

  constructor(
    private readonly client: RedisConcurrencyClient | undefined,
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
      this.reportDegraded();
      throw this.unavailableError();
    }

    const sandbox = request.environment === 'sandbox';
    const organizationKey = `aihub:v1:inflight:${request.organizationId}`;
    const sandboxKey = 'aihub:v1:inflight:sandbox';
    const keys = sandbox ? [organizationKey, sandboxKey] : [organizationKey];
    try {
      const result = await this.client.eval(
        sandbox
          ? ACQUIRE_SANDBOX_CONCURRENCY_SCRIPT
          : ACQUIRE_CONCURRENCY_SCRIPT,
        keys.length,
        ...keys,
        ...(sandbox
          ? ['1', '10', request.requestId, String(CONCURRENCY_STALE_LEASE_MS)]
          : [
              String(request.maxConcurrent),
              request.requestId,
              String(CONCURRENCY_STALE_LEASE_MS),
            ]),
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
        lease: this.remoteLease(this.client, keys, request.requestId),
      };
    } catch (error) {
      this.reportDegraded(error);
      throw this.unavailableError(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private remoteLease(
    client: RedisConcurrencyClient,
    keys: readonly string[],
    requestId: string,
  ): ConcurrencyLease {
    let released = false;
    return {
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await Promise.all(keys.map((key) => client.zrem(key, requestId)));
          this.reportRecovered();
        } catch (error) {
          this.reportDegraded(error);
        }
      },
    };
  }

  private reportDegraded(error?: unknown): void {
    if (this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = true;
    const reason = error instanceof Error ? error.message : 'Redis unavailable';
    this.logger.warn(
      `Redis concurrency limiter unreachable (${reason}); refusing requests until it recovers`,
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = false;
    this.logger.log('Redis concurrency limiter recovered');
  }

  private unavailableError(cause?: unknown): AppError {
    return new AppError({
      code: 'REDIS_UNAVAILABLE',
      message: 'Grading controls are temporarily unavailable',
      retryable: true,
      retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS,
      diagnostic: 'graded-concurrency-redis-unavailable',
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
