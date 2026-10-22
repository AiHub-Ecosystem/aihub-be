import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRequest,
} from '@/modules/gateway/application/graded-admission.port';
import { quotaUnverifiableError } from '@/modules/gateway/application/quota-admission';
import type { QuotaCounterSeedPort } from '@/modules/gateway/application/quota-counter.port';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import { rateLimitWindow } from '@/modules/gateway/application/rate-limit-window';
import type { RateLimitStanding } from '@/modules/gateway/application/rate-limiter.port';
import { jitteredRetryAfterMs } from '@/modules/gateway/application/retry-hint';
import type { RedisGatewayClient } from './redis-gateway.client';
import { ORGANIZATION_RETRY_SEEN_CAP } from './redis-organization-retry-budget';
import { quotaKeyForMonth } from './redis-quota-counter';

const QUOTA_COUNTER_MISSING = 5;
const UNAVAILABLE_RETRY_AFTER_MS = 1_000;

// Returns {result, rate_count}: the count feeds the RateLimit header fields.
export const GRADED_ADMISSION_SCRIPT = `
local rate_count = 0
local function admit()
if ARGV[6] ~= '' and redis.call('EXISTS', KEYS[5]) == 0 then return 5 end

rate_count = redis.call('INCR', KEYS[1])
if rate_count == 1 then redis.call('EXPIRE', KEYS[1], 120) end
if rate_count > tonumber(ARGV[1]) then return 1 end

if ARGV[2] == '1' then
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  local cutoff = now - 60000
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', cutoff)
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
  local seen = redis.call('ZSCORE', KEYS[4], ARGV[3])
  if not seen then
    redis.call('ZADD', KEYS[4], now + 86400000, ARGV[3])
    local cap = tonumber(ARGV[5])
    if cap and cap > 0 then
      redis.call('ZREMRANGEBYRANK', KEYS[4], 0, -(cap + 1))
    end
    redis.call('ZADD', KEYS[2], now, ARGV[4])
    redis.call('EXPIRE', KEYS[2], 120)
    redis.call('EXPIRE', KEYS[3], 120)
    redis.call('EXPIRE', KEYS[4], 86460)
  else
    local first_attempts = redis.call('ZCARD', KEYS[2])
    local admitted_repeats = redis.call('ZCARD', KEYS[3])
    local allowance = math.max(1, math.floor(0.10 * first_attempts))
    if admitted_repeats >= allowance then
      redis.call('EXPIRE', KEYS[2], 120)
      redis.call('EXPIRE', KEYS[3], 120)
      redis.call('EXPIRE', KEYS[4], 86460)
      return 2
    end
    redis.call('ZADD', KEYS[3], now, ARGV[4])
    redis.call('EXPIRE', KEYS[2], 120)
    redis.call('EXPIRE', KEYS[3], 120)
    redis.call('EXPIRE', KEYS[4], 86460)
  end
end

if ARGV[6] ~= '' then
  local raw_count = redis.call('GET', KEYS[5])
  local count = raw_count and tonumber(raw_count) or 0
  local quota = tonumber(ARGV[6])
  if not count or count < 0 or count ~= math.floor(count) or not quota then return 4 end
  if count >= quota then return 3 end
end

return 0
end

local result = admit()
return {result, rate_count}
`;

export type RedisGradedAdmissionClient = Pick<
  RedisGatewayClient,
  'evalNumbers' | 'quit'
>;

interface LoggerLike {
  warn(message: string): void;
  log(message: string): void;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redisUnavailable(cause?: unknown): AppError {
  return new AppError({
    code: 'REDIS_UNAVAILABLE',
    message: 'Grading controls are temporarily unavailable',
    retryable: true,
    retryAfterMs: UNAVAILABLE_RETRY_AFTER_MS,
    diagnostic: 'graded-admission-redis-unavailable',
    ...(cause === undefined ? {} : { cause }),
  });
}

export class RedisGradedAdmission implements GradedAdmissionPort {
  private redisIsDegraded = false;

  constructor(
    private readonly client: RedisGradedAdmissionClient | undefined,
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random,
    private readonly logger: LoggerLike = new Logger(RedisGradedAdmission.name),
    private readonly seeder?: QuotaCounterSeedPort,
  ) {}

  async consume(
    request: GradedAdmissionRequest,
  ): Promise<GradedAdmissionDecision> {
    const client = this.client;
    if (client === undefined) {
      this.reportDegraded();
      throw redisUnavailable();
    }

    const now = this.now();
    const window = rateLimitWindow(request.apiKeyId, now);
    const quota = request.monthlyRequestQuota;
    let [result, rateCount] = await this.evaluate(
      client,
      request,
      window.index,
      now,
      quota,
    );
    let quotaUnverified = false;
    // The script stops before any write when the quota counter is missing,
    // so it can run again once the counter is rebuilt (#371).
    if (result === QUOTA_COUNTER_MISSING) {
      try {
        if (this.seeder === undefined) {
          throw new Error('No quota counter source is configured');
        }
        await this.seeder.seed(request.organizationId, new Date(now));
        [result, rateCount] = await this.evaluate(
          client,
          request,
          window.index,
          now,
          quota,
        );
        if (result === QUOTA_COUNTER_MISSING) {
          throw new Error('Redis quota counter is missing');
        }
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        if (request.hardStopOnQuota) throw quotaUnverifiableError();
        [result, rateCount] = await this.evaluate(
          client,
          request,
          window.index,
          now,
          null,
        );
        quotaUnverified = true;
      }
    }

    this.reportRecovered();
    const rate: RateLimitStanding = {
      limit: request.rateLimitRpm,
      remaining: Math.max(0, request.rateLimitRpm - rateCount),
      resetInMs: window.resetInMs,
    };
    switch (result) {
      case 0:
        return quotaUnverified
          ? { stage: 'admitted', quotaUnverified: true, rate }
          : { stage: 'admitted', rate };
      case 1:
        return {
          stage: 'rate_limit',
          retryAfterMs: jitteredRetryAfterMs(window.resetInMs, this.random),
          rate,
        };
      case 2:
        return {
          stage: 'retry_budget',
          retryAfterMs: jitteredRetryAfterMs(60_000, this.random),
          rate,
        };
      case 3:
        return { stage: 'quota', quota: quota ?? 0, rate };
      case 4:
      default:
        this.reportDegraded();
        throw redisUnavailable(
          new Error('Redis graded admission result is invalid'),
        );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private async evaluate(
    client: RedisGradedAdmissionClient,
    request: GradedAdmissionRequest,
    window: number,
    now: number,
    quota: number | null,
  ): Promise<readonly [number, number]> {
    const retryPrefix = `aihub:v1:org-retry:{${digest(request.organizationId)}}`;
    const applyRetryBudget = request.idempotencyKey !== undefined;
    let reply: readonly number[];
    try {
      reply = await client.evalNumbers(
        GRADED_ADMISSION_SCRIPT,
        5,
        `aihub:v1:rl:${request.apiKeyId}:${window}`,
        `${retryPrefix}:first`,
        `${retryPrefix}:repeats`,
        `${retryPrefix}:seen`,
        quotaKeyForMonth(
          request.organizationId,
          quotaPeriod(new Date(now)).key,
        ),
        String(request.rateLimitRpm),
        applyRetryBudget ? '1' : '0',
        applyRetryBudget
          ? digest(`${request.operation}\u0000${request.idempotencyKey}`)
          : '',
        request.requestId,
        String(ORGANIZATION_RETRY_SEEN_CAP),
        quota === null ? '' : String(quota),
      );
    } catch (cause) {
      this.reportDegraded();
      throw redisUnavailable(cause);
    }
    const [result, rateCount] = reply;
    if (result === undefined || rateCount === undefined) {
      this.reportDegraded();
      throw redisUnavailable(
        new Error('Redis graded admission result is invalid'),
      );
    }
    return [result, rateCount];
  }

  private reportDegraded(): void {
    recordRedisUnavailable('graded_admission');
    if (this.redisIsDegraded) return;
    this.redisIsDegraded = true;
    this.logger.warn(
      'Redis graded admission unavailable; refusing requests until it recovers',
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) return;
    this.redisIsDegraded = false;
    this.logger.log('Redis graded admission recovered');
  }
}
