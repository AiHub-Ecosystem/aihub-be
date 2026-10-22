import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { jitteredRetryAfterMs } from '@/common/errors/retry-jitter';
import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import type {
  OrganizationRetryBudgetDecision,
  OrganizationRetryBudgetPort,
  OrganizationRetryBudgetRequest,
} from '@/modules/gateway/application/organization-retry-budget.port';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './redis-gateway.client';

/** How long a same-key repeat is refused for: one window of first attempts. */
export const RETRY_BUDGET_WINDOW_MS = 60_000;

/**
 * How many distinct Idempotency-Keys one Organization's retry budget remembers.
 *
 * A safety bound, not a capacity promise: without it the ledger tracks the
 * Organization's first-attempt volume for a rolling day, so one busy tenant
 * could grow the shared Redis by hundreds of megabytes. The gateway's quota
 * counter, rate limit, and concurrency leases share that instance and AIHUB
 * requires `noeviction` (#371), so an unbounded ledger would turn every Redis
 * write into an error, not only this one.
 *
 * At the ceiling the oldest remembered keys are dropped, so a dropped key's
 * next request counts as a first attempt. That direction is deliberate: the
 * budget may become more permissive for an old key, but it never refuses a
 * first attempt it could not classify.
 */
export const ORGANIZATION_RETRY_SEEN_CAP = 10_000;

export const ORGANIZATION_RETRY_BUDGET_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - 60000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local seen = redis.call('ZSCORE', KEYS[3], ARGV[1])
if not seen then
  redis.call('ZADD', KEYS[3], now + 86400000, ARGV[1])
  local cap = tonumber(ARGV[3])
  if cap and cap > 0 then
    redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(cap + 1))
  end
  redis.call('ZADD', KEYS[1], now, ARGV[2])
  redis.call('EXPIRE', KEYS[1], 120)
  redis.call('EXPIRE', KEYS[2], 120)
  redis.call('EXPIRE', KEYS[3], 86460)
  return 1
end
local firstAttempts = redis.call('ZCARD', KEYS[1])
local admittedRepeats = redis.call('ZCARD', KEYS[2])
local allowance = math.max(1, math.floor(0.10 * firstAttempts))
if admittedRepeats >= allowance then
  redis.call('EXPIRE', KEYS[1], 120)
  redis.call('EXPIRE', KEYS[2], 120)
  redis.call('EXPIRE', KEYS[3], 86460)
  return 0
end
redis.call('ZADD', KEYS[2], now, ARGV[2])
redis.call('EXPIRE', KEYS[1], 120)
redis.call('EXPIRE', KEYS[2], 120)
redis.call('EXPIRE', KEYS[3], 86460)
return 1
`;

export type RedisOrganizationRetryBudgetClient = Pick<
  RedisGatewayClient,
  'eval' | 'quit'
>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class RedisOrganizationRetryBudget
  implements OrganizationRetryBudgetPort
{
  private readonly client: RedisOrganizationRetryBudgetClient | undefined;
  private readonly random: () => number;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;
  private redisIsDegraded = false;

  constructor(
    url: string,
    client?: RedisOrganizationRetryBudgetClient,
    random: () => number = Math.random,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(
      RedisOrganizationRetryBudget.name,
    ),
  ) {
    this.client = client ?? createRedisGatewayClient(url);
    this.random = random;
    this.logger = logger;
  }

  async consume(
    request: OrganizationRetryBudgetRequest,
  ): Promise<OrganizationRetryBudgetDecision> {
    const organizationHash = digest(request.organizationId);
    const requestHash = digest(
      `${request.operation}\u0000${request.idempotencyKey}`,
    );
    const client = this.client;
    if (client === undefined) {
      this.reportDegraded();
      throw this.unavailableError();
    }

    const prefix = `aihub:v1:org-retry:{${organizationHash}}`;
    try {
      const result = await client.eval(
        ORGANIZATION_RETRY_BUDGET_SCRIPT,
        3,
        `${prefix}:first`,
        `${prefix}:repeats`,
        `${prefix}:seen`,
        requestHash,
        request.requestId,
        String(ORGANIZATION_RETRY_SEEN_CAP),
      );
      if (result !== 0 && result !== 1) {
        throw new Error('Redis retry budget result is invalid');
      }
      this.reportRecovered();
      return result === 1 ? { allowed: true } : this.rejection();
    } catch (cause) {
      this.reportDegraded();
      throw this.unavailableError(cause);
    }
  }

  private reportDegraded(): void {
    recordRedisUnavailable('retry_budget');
    if (this.redisIsDegraded) return;
    this.redisIsDegraded = true;
    this.logger.warn(
      'Redis organization retry budget unavailable; rejecting requests until it recovers',
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) return;
    this.redisIsDegraded = false;
    this.logger.log('Redis organization retry budget recovered');
  }

  private rejection(): OrganizationRetryBudgetDecision {
    return {
      allowed: false,
      retryAfterMs: jitteredRetryAfterMs(RETRY_BUDGET_WINDOW_MS, this.random),
    };
  }

  private unavailableError(cause?: unknown): AppError {
    return new AppError({
      code: 'RETRY_BUDGET_UNAVAILABLE',
      message: 'Organization retry budget is unavailable',
      retryable: true,
      retryAfterMs: 1_000,
      diagnostic: 'organization-retry-budget-redis-unavailable',
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
