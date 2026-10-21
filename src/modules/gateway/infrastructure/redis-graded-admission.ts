import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRequest,
} from '@/modules/gateway/application/graded-admission.port';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import type { RedisGatewayClient } from './redis-gateway.client';
import { ORGANIZATION_RETRY_SEEN_CAP } from './redis-organization-retry-budget';
import { quotaKeyForMonth } from './redis-quota-counter';

const RATE_WINDOW_MS = 60_000;
const RETRY_HINT_JITTER_MS = 1_000;
const UNAVAILABLE_RETRY_AFTER_MS = 1_000;

export const GRADED_ADMISSION_SCRIPT = `
local rate_count = redis.call('INCR', KEYS[1])
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
`;

export type RedisGradedAdmissionClient = Pick<
  RedisGatewayClient,
  'eval' | 'quit'
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
  ) {}

  async consume(
    request: GradedAdmissionRequest,
  ): Promise<GradedAdmissionDecision> {
    if (this.client === undefined) {
      this.reportDegraded();
      throw redisUnavailable();
    }

    const now = this.now();
    const minute = Math.floor(now / RATE_WINDOW_MS);
    const organizationHash = digest(request.organizationId);
    const retryPrefix = `aihub:v1:org-retry:{${organizationHash}}`;
    const applyRetryBudget = request.idempotencyKey !== undefined;
    const retryFingerprint = applyRetryBudget
      ? digest(`${request.operation}\u0000${request.idempotencyKey}`)
      : '';
    const month = new Date(now);
    const quotaKey = quotaKeyForMonth(
      request.organizationId,
      quotaPeriod(month).key,
    );
    const quota = request.monthlyRequestQuota;
    let result: number;

    try {
      result = await this.client.eval(
        GRADED_ADMISSION_SCRIPT,
        5,
        `aihub:v1:rl:${request.apiKeyId}:${minute}`,
        `${retryPrefix}:first`,
        `${retryPrefix}:repeats`,
        `${retryPrefix}:seen`,
        quotaKey,
        String(request.rateLimitRpm),
        applyRetryBudget ? '1' : '0',
        retryFingerprint,
        request.requestId,
        String(ORGANIZATION_RETRY_SEEN_CAP),
        quota === null ? '' : String(quota),
      );
    } catch (cause) {
      this.reportDegraded();
      throw redisUnavailable(cause);
    }

    this.reportRecovered();
    switch (result) {
      case 0:
        return { stage: 'admitted' };
      case 1:
        return {
          stage: 'rate_limit',
          retryAfterMs: Math.max(1, RATE_WINDOW_MS - (now % RATE_WINDOW_MS)),
        };
      case 2:
        return {
          stage: 'retry_budget',
          retryAfterMs:
            60_000 + Math.floor(this.random() * RETRY_HINT_JITTER_MS),
        };
      case 3:
        return { stage: 'quota', quota: quota ?? 0 };
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
