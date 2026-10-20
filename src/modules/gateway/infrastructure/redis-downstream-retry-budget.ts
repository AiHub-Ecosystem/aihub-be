import { createHash } from 'node:crypto';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { DownstreamId } from '@/downstream/downstream.types';
import type {
  DownstreamRetryBudgetDecision,
  DownstreamRetryBudgetPort,
} from '@/modules/gateway/application/downstream-retry-budget.port';
import type { RedisGatewayClient } from './redis-gateway.client';

const WINDOW_MS = 60_000;
const KEY_TTL_SECONDS = 120;
const OPERATION_RETRY_RATIO = 0.1;

export interface DownstreamRetryServiceBucket {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly expectedAttemptMs: number;
}

export const RECORD_DOWNSTREAM_FIRST_ATTEMPT_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
redis.call('ZADD', KEYS[1], 'NX', now, ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

export const RESERVE_DOWNSTREAM_RETRY_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local cutoff = now - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
local firstAttempts = redis.call('ZCARD', KEYS[1])
if firstAttempts == 0 then return 0 end
local allowedRetries = math.floor(tonumber(ARGV[4]) * firstAttempts)
if redis.call('ZCARD', KEYS[2]) >= allowedRetries then return 0 end
redis.call('ZADD', KEYS[2], 'NX', now, ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

export const RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local updated = tonumber(redis.call('HGET', KEYS[1], 'updated'))
if not tokens or not updated then
  tokens = burst
  updated = now
end
tokens = math.min(burst, tokens + math.max(0, now - updated) * rate / 1000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'updated', now)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

export type RedisDownstreamRetryBudgetClient = Pick<RedisGatewayClient, 'eval'>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class RedisDownstreamRetryBudget implements DownstreamRetryBudgetPort {
  constructor(
    private readonly client: RedisDownstreamRetryBudgetClient | undefined,
    private readonly serviceBuckets: Readonly<
      Partial<Record<DownstreamId, DownstreamRetryServiceBucket>>
    > = {},
  ) {}

  isEnabled(operation: OperationId): boolean {
    return (
      this.serviceBuckets[OPERATION_CATALOG[operation].downstream] !== undefined
    );
  }

  expectedAttemptMs(operation: OperationId): number | undefined {
    const bucket = this.serviceBuckets[OPERATION_CATALOG[operation].downstream];
    return validBucket(bucket) ? bucket.expectedAttemptMs : undefined;
  }

  async recordFirstAttempt(
    operation: OperationId,
    requestId: string,
  ): Promise<boolean> {
    const client = this.client;
    const bucket = this.serviceBuckets[OPERATION_CATALOG[operation].downstream];
    if (client === undefined || !validBucket(bucket)) return false;
    const [firstKey, retryKey] = this.keys(operation);
    try {
      const result = await client.eval(
        RECORD_DOWNSTREAM_FIRST_ATTEMPT_SCRIPT,
        2,
        firstKey,
        retryKey,
        digest(requestId),
        String(WINDOW_MS),
        String(KEY_TTL_SECONDS),
      );
      return result === 1;
    } catch {
      return false;
    }
  }

  async reserveRetry(
    operation: OperationId,
    requestId: string,
    retryNumber: number,
  ): Promise<DownstreamRetryBudgetDecision> {
    const client = this.client;
    const downstream = OPERATION_CATALOG[operation].downstream;
    const bucket = this.serviceBuckets[downstream];
    if (client === undefined || !validBucket(bucket)) return 'unavailable';
    if (!Number.isSafeInteger(retryNumber) || retryNumber < 1) {
      return 'unavailable';
    }
    const [firstKey, retryKey] = this.keys(operation);
    try {
      const result = await client.eval(
        RESERVE_DOWNSTREAM_RETRY_SCRIPT,
        2,
        firstKey,
        retryKey,
        digest(`${requestId}:${retryNumber}`),
        String(WINDOW_MS),
        String(KEY_TTL_SECONDS),
        String(OPERATION_RETRY_RATIO),
      );
      if (result !== 1) return result === 0 ? 'exhausted' : 'unavailable';
      // A service refusal burns this operation slot, which can only under-admit.
      const serviceResult = await client.eval(
        RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT,
        1,
        this.serviceKey(downstream),
        String(bucket.ratePerSecond),
        String(bucket.burst),
        String(KEY_TTL_SECONDS),
      );
      if (serviceResult === 1) return 'admitted';
      return serviceResult === 0 ? 'exhausted' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  private keys(operation: OperationId): readonly [string, string] {
    const prefix = `aihub:v1:downstream-retry:{${operation}}`;
    return [`${prefix}:first`, `${prefix}:retries`];
  }

  private serviceKey(downstream: DownstreamId): string {
    return `aihub:v1:downstream-retry-service:{${downstream}}`;
  }
}

function validBucket(
  bucket: DownstreamRetryServiceBucket | undefined,
): bucket is DownstreamRetryServiceBucket {
  return (
    bucket !== undefined &&
    Number.isFinite(bucket.ratePerSecond) &&
    bucket.ratePerSecond > 0 &&
    Number.isSafeInteger(bucket.burst) &&
    bucket.burst > 0 &&
    Number.isSafeInteger(bucket.expectedAttemptMs) &&
    bucket.expectedAttemptMs > 0
  );
}
