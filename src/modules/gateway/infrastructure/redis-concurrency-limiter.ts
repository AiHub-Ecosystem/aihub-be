import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import {
  jitteredRetryAfterMs,
  outageRetryAfterMs,
} from '@/common/errors/retry-jitter';
import {
  backgroundWorkSettled,
  backgroundWorkStarted,
  isShuttingDown,
} from '@/common/http/background-work-drain';
import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import type {
  ConcurrencyDecision,
  ConcurrencyLease,
  ConcurrencyLimiterPort,
  ConcurrencyRequest,
} from '@/modules/gateway/application/concurrency-limiter.port';
import {
  REDIS_COMMAND_TIMEOUT_MS,
  type RedisGatewayClient,
} from './redis-gateway.client';

export type RedisConcurrencyClient = Pick<
  RedisGatewayClient,
  'eval' | 'zrem' | 'quit'
>;

/** A refused permit is told to wait this long, plus up to as long again. */
export const CONCURRENCY_RETRY_AFTER_MS = 500;
export const CONCURRENCY_STALE_LEASE_MS = 120_000;
export const LEASE_REMOVAL_RETRY_MS = 1_000;
// Keep 15 seconds of the 75-second graceful drain for event-loop delay.
const LEASE_REMOVAL_SHUTDOWN_BUDGET_MS = 60_000;
const LEASE_REMOVAL_ATTEMPTS = Math.floor(
  (CONCURRENCY_STALE_LEASE_MS - LEASE_REMOVAL_RETRY_MS) /
    (LEASE_REMOVAL_RETRY_MS + REDIS_COMMAND_TIMEOUT_MS),
);

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

export class RedisConcurrencyLimiter implements ConcurrencyLimiterPort {
  private redisIsDegraded = false;
  private stopping = false;
  private readonly pendingRemovals = new Set<() => void>();
  private readonly removalTimers = new Map<
    () => void,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly client: RedisConcurrencyClient | undefined,
    private readonly logger: LoggerLike = new Logger(
      RedisConcurrencyLimiter.name,
    ),
    private readonly random: () => number = Math.random,
  ) {}

  async acquire(request: ConcurrencyRequest): Promise<ConcurrencyDecision> {
    if (
      !Number.isInteger(request.maxConcurrent) ||
      request.maxConcurrent <= 0
    ) {
      return this.denied();
    }

    const client = this.client;
    if (client === undefined) {
      this.reportDegraded();
      throw this.unavailableError();
    }

    const sandbox = request.environment === 'sandbox';
    const organizationKey = `aihub:v1:inflight:${request.organizationId}`;
    const sandboxKey = 'aihub:v1:inflight:sandbox';
    const keys = sandbox ? [organizationKey, sandboxKey] : [organizationKey];
    try {
      const result = await client.eval(
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
        return this.denied();
      }
      if (result !== 1) {
        throw new Error('Redis concurrency response is invalid');
      }

      this.reportRecovered();
      return {
        allowed: true,
        lease: this.remoteLease(client, keys, request.requestId),
      };
    } catch (error) {
      // A slow reply can time out after Redis already added the lease.
      this.removeLater(client, keys, request.requestId);
      this.reportDegraded(error);
      throw this.unavailableError(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const settle of this.pendingRemovals) settle();
    await this.client?.quit().catch(() => undefined);
  }

  private remoteLease(
    client: RedisConcurrencyClient,
    keys: readonly string[],
    requestId: string,
  ): ConcurrencyLease {
    let releaseAttempt: Promise<void> | undefined;
    return {
      release: () => {
        releaseAttempt ??= Promise.resolve().then(async () => {
          try {
            await Promise.all(keys.map((key) => client.zrem(key, requestId)));
            this.reportRecovered();
            return undefined;
          } catch (error) {
            this.removeLater(client, keys, requestId);
            this.reportDegraded(error);
            throw this.unavailableError(error);
          }
        });
        return releaseAttempt;
      },
    };
  }

  // A retry-exhausted permit is pruned on the next acquire after its stale window.
  private removeLater(
    client: RedisConcurrencyClient,
    keys: readonly string[],
    requestId: string,
    attempt = 1,
    settle?: () => void,
    shutdownStartedAt?: number,
  ): void {
    if (settle === undefined) {
      backgroundWorkStarted();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const timer = this.removalTimers.get(finish);
        if (timer !== undefined) clearTimeout(timer);
        this.removalTimers.delete(finish);
        this.pendingRemovals.delete(finish);
        backgroundWorkSettled();
      };
      this.pendingRemovals.add(finish);
      this.removeLater(client, keys, requestId, attempt, finish);
      return;
    }
    const shutdownStartedAtForRetry = isShuttingDown()
      ? (shutdownStartedAt ?? Date.now())
      : undefined;
    if (
      this.stopping ||
      (shutdownStartedAtForRetry !== undefined &&
        Date.now() - shutdownStartedAtForRetry >=
          LEASE_REMOVAL_SHUTDOWN_BUDGET_MS)
    ) {
      settle();
      return;
    }

    const timer = setTimeout(() => {
      this.removalTimers.delete(settle);
      void Promise.resolve()
        .then(() => Promise.all(keys.map((key) => client.zrem(key, requestId))))
        .then(
          () => {
            this.reportRecovered();
            settle();
            return true;
          },
          () => {
            recordRedisUnavailable('concurrency');
            if (attempt < LEASE_REMOVAL_ATTEMPTS && !this.stopping) {
              this.removeLater(
                client,
                keys,
                requestId,
                attempt + 1,
                settle,
                shutdownStartedAtForRetry,
              );
            } else {
              settle();
            }
            return false;
          },
        );
    }, LEASE_REMOVAL_RETRY_MS);
    this.removalTimers.set(settle, timer);
    timer.unref();
  }

  private denied(): ConcurrencyDecision {
    return {
      allowed: false,
      retryAfterMs: jitteredRetryAfterMs(
        CONCURRENCY_RETRY_AFTER_MS,
        this.random,
        CONCURRENCY_RETRY_AFTER_MS,
      ),
    };
  }

  private reportDegraded(error?: unknown): void {
    recordRedisUnavailable('concurrency');
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
      retryAfterMs: outageRetryAfterMs(this.random),
      diagnostic: 'graded-concurrency-redis-unavailable',
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
