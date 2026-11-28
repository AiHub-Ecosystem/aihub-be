import { createHash } from 'node:crypto';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { DownstreamId } from '@/downstream/downstream.types';
import type {
  DownstreamRetryBudgetDecision,
  DownstreamRetryBudgetPort,
} from '@/modules/gateway/application/dispatch/downstream-retry-budget.port';
import type { RedisGatewayClient } from './redis-gateway.client';

const WINDOW_MS = 60_000;
const KEY_TTL_SECONDS = 120;
const MAX_REDIS_TTL_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const OPERATION_RETRY_RATIO = 0.1;

export interface DownstreamRetryServiceBucket {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly expectedAttemptMs: number;
}

const RETRY_LEDGER_CLOCK = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function ledgerStartedAt(firstKey, retryKey)
  local first = tonumber(redis.call('ZSCORE', firstKey, ':started'))
  local retries = tonumber(redis.call('ZSCORE', retryKey, ':started'))
  if first and first == retries then return -first end
end
`;

// Negative scores keep the start marker in each ledger when the window is empty.
export const RECORD_DOWNSTREAM_FIRST_ATTEMPT_SCRIPT = `${RETRY_LEDGER_CLOCK}
local cutoff = now - tonumber(ARGV[2])
if not ledgerStartedAt(KEYS[1], KEYS[2]) then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('ZADD', KEYS[1], -now, ':started')
  redis.call('ZADD', KEYS[2], -now, ':started')
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, cutoff)
redis.call('ZADD', KEYS[1], 'NX', now, ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

export const RESERVE_DOWNSTREAM_RETRY_SCRIPT = `${RETRY_LEDGER_CLOCK}
local cutoff = now - tonumber(ARGV[2])
local startedAt = ledgerStartedAt(KEYS[1], KEYS[2])
if not startedAt then return -1 end
if startedAt > cutoff then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, cutoff)
local firstAttempts = redis.call('ZCARD', KEYS[1]) - 1
local allowedRetries = math.floor(tonumber(ARGV[4]) * firstAttempts)
if redis.call('ZCARD', KEYS[2]) - 1 >= allowedRetries then return 0 end
if redis.call('ZADD', KEYS[2], 'NX', now, ARGV[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return 1
`;

export const RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT = `${RETRY_LEDGER_CLOCK}
local reservedAt = tonumber(redis.call('ZSCORE', KEYS[3], ARGV[4]))
if not ledgerStartedAt(KEYS[2], KEYS[3]) or
  not reservedAt or reservedAt <= now - tonumber(ARGV[5]) then return -1 end
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local updated = tonumber(redis.call('HGET', KEYS[1], 'updated'))
if not tokens or not updated then
  tokens = 0
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
    return validBucket(
      this.serviceBuckets[OPERATION_CATALOG[operation].downstream],
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
    const retry = digest(`${requestId}:${retryNumber}`);
    try {
      const result = await client.eval(
        RESERVE_DOWNSTREAM_RETRY_SCRIPT,
        2,
        firstKey,
        retryKey,
        retry,
        String(WINDOW_MS),
        String(KEY_TTL_SECONDS),
        String(OPERATION_RETRY_RATIO),
      );
      if (result !== 1) return result === 0 ? 'exhausted' : 'unavailable';
      // A service refusal burns this operation slot, which can only under-admit.
      const serviceResult = await client.eval(
        RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT,
        3,
        this.serviceKey(downstream),
        firstKey,
        retryKey,
        String(bucket.ratePerSecond),
        String(bucket.burst),
        String(serviceBucketTtlSeconds(bucket)),
        retry,
        String(WINDOW_MS),
      );
      if (serviceResult === 1) return 'admitted';
      return serviceResult === 0 ? 'exhausted' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  private keys(operation: OperationId): readonly [string, string] {
    const downstream = OPERATION_CATALOG[operation].downstream;
    const prefix = `aihub:v1:downstream-retry:{${downstream}}:${operation}`;
    return [`${prefix}:first`, `${prefix}:retries`];
  }

  private serviceKey(downstream: DownstreamId): string {
    return `aihub:v1:downstream-retry-service:{${downstream}}`;
  }
}

function validBucket(
  bucket: DownstreamRetryServiceBucket | undefined,
): bucket is DownstreamRetryServiceBucket {
  if (
    bucket === undefined ||
    !Number.isFinite(bucket.ratePerSecond) ||
    bucket.ratePerSecond <= 0 ||
    !Number.isSafeInteger(bucket.burst) ||
    bucket.burst <= 0 ||
    !Number.isSafeInteger(bucket.expectedAttemptMs) ||
    bucket.expectedAttemptMs <= 0
  ) {
    return false;
  }
  const ttlSeconds = serviceBucketTtlSeconds(bucket);
  return (
    Number.isSafeInteger(ttlSeconds) && ttlSeconds <= MAX_REDIS_TTL_SECONDS
  );
}

function serviceBucketTtlSeconds(bucket: DownstreamRetryServiceBucket): number {
  return Math.max(
    KEY_TTL_SECONDS,
    Math.ceil(bucket.burst / bucket.ratePerSecond),
  );
}
