import { Logger } from '@nestjs/common';

import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { AppError, internalError } from '@/common/errors/app-error';
import {
  jitteredRetryAfterMs,
  outageRetryAfterMs,
} from '@/common/errors/retry-jitter';
import { shutdownStartedAt } from '@/common/http/runtime/background-work-drain';
import {
  backgroundDrainMs,
  largestRequestTimeoutMs,
} from '@/common/http/runtime/shutdown-budget';
import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import type {
  ConcurrencyDecision,
  ConcurrencyLease,
  ConcurrencyLimiterPort,
  ConcurrencyRequest,
} from '@/modules/gateway/application/concurrency-limiter.port';
import type { RedisGatewayClient } from './redis-gateway.client';

export type RedisConcurrencyClient = Pick<RedisGatewayClient, 'eval' | 'zrem'>;

// ioredis rejects with this before writing when the socket is not writable and
// the offline queue is off (createRedisClient), so no lease can exist yet.
const COMMAND_NOT_SENT_MESSAGE =
  "Stream isn't writeable and enableOfflineQueue options is false";

function isCommandNotSent(error: unknown): boolean {
  return error instanceof Error && error.message === COMMAND_NOT_SENT_MESSAGE;
}

/** A refused permit is told to wait this long, plus up to as long again. */
export const CONCURRENCY_RETRY_AFTER_MS = 500;
// A lease older than this no longer counts toward the cap, so it must outlast
// the longest response deadline by the finalization margin.
export const CONCURRENCY_STALE_LEASE_MS = largestRequestTimeoutMs() + 10_000;
export const LEASE_REMOVAL_RETRY_MS = 1_000;
// Retry for as long as the background drain waits, keeping 15 seconds of it for
// event-loop delay. Derived, so a longer route timeout widens both together.
const LEASE_REMOVAL_SHUTDOWN_BUDGET_MS =
  backgroundDrainMs(largestRequestTimeoutMs()) - 15_000;

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
  warn(fields: Record<string, unknown>): void;
  log(fields: Record<string, unknown>): void;
}

export class RedisConcurrencyLimiter implements ConcurrencyLimiterPort {
  private readonly health: RedisHealthReporter;
  private stopping = false;
  private readonly pendingRemovals = new Set<() => void>();
  private readonly removalTimers = new Map<
    () => void,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly client: RedisConcurrencyClient | undefined,
    logger: LoggerLike = new Logger(RedisConcurrencyLimiter.name),
    private readonly random: () => number = Math.random,
  ) {
    this.health = new RedisHealthReporter(
      'concurrency',
      'concurrency limiter',
      logger,
      'refusing requests until it recovers',
    );
  }

  async acquire(request: ConcurrencyRequest): Promise<ConcurrencyDecision> {
    if (
      !Number.isInteger(request.maxConcurrent) ||
      request.maxConcurrent <= 0
    ) {
      return this.denied();
    }

    const client = this.client;
    if (client === undefined) {
      this.health.reportDegraded();
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
        this.health.reportRecovered();
        return this.denied();
      }
      if (result !== 1) {
        throw internalError('Redis concurrency response is invalid');
      }

      this.health.reportRecovered();
      return {
        allowed: true,
        lease: this.remoteLease(client, keys, request.requestId),
      };
    } catch (error) {
      // Only a timeout or lost reply may have added the lease. A command the
      // socket refused to write cannot have, so cleanup would retry for the
      // whole stale window with nothing to remove.
      if (!isCommandNotSent(error)) {
        this.removeLater(client, keys, request.requestId);
      }
      this.health.reportDegraded(error);
      throw this.unavailableError(error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const settle of this.pendingRemovals) settle();
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
            this.health.reportRecovered();
            return undefined;
          } catch (error) {
            this.removeLater(client, keys, requestId);
            this.health.reportDegraded(error);
            throw this.unavailableError(error);
          }
        });
        return releaseAttempt;
      },
    };
  }

  // Retries run until the stale window, however fast each ZREM fails; a
  // permit still held then is pruned on the next acquire.
  private removeLater(
    client: RedisConcurrencyClient,
    keys: readonly string[],
    requestId: string,
    startedAt = Date.now(),
    settle?: () => void,
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
      this.removeLater(client, keys, requestId, startedAt, finish);
      return;
    }
    // Measured from shutdown itself: a release deferred until background work
    // settles can first fail well into the drain.
    const shutdownAt = shutdownStartedAt();
    if (
      this.stopping ||
      (shutdownAt !== undefined &&
        Date.now() - shutdownAt >= LEASE_REMOVAL_SHUTDOWN_BUDGET_MS)
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
            this.health.reportRecovered();
            settle();
            return true;
          },
          (error) => {
            this.health.reportDegraded(error);
            if (
              Date.now() + LEASE_REMOVAL_RETRY_MS - startedAt <
                CONCURRENCY_STALE_LEASE_MS &&
              !this.stopping
            ) {
              this.removeLater(client, keys, requestId, startedAt, settle);
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
