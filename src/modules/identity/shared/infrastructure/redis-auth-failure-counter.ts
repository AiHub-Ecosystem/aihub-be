import { Logger } from '@nestjs/common';

import { internalError } from '@/common/errors/app-error';
import { incrementRedisCounterWithExpiry } from '@/common/redis/increment-with-expiry';
import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import {
  API_KEY_LOOKUP_BUDGET_BURST,
  API_KEY_LOOKUP_BUDGET_PER_SECOND,
  API_KEY_LOOKUP_FALLBACK_BURST,
  API_KEY_LOOKUP_FALLBACK_PER_SECOND,
  type ApiKeyLookupBudgetDecision,
  type AuthFailureCounterPort,
  apiKeyLookupBudgetKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { SANDBOX_API_KEY_RATE_LIMIT_RPM } from '@/modules/identity/shared/application/sandbox-api-key-rate-limit';
import { putBounded } from './local-cache-policy';
import {
  type RedisIdentityClient,
  connectRedisIdentityClient,
} from './redis-identity-client';

const AUTH_FAILURE_WINDOW_SECONDS = 300;
// One entry per failed address; oldest-first eviction bounds outage memory.
const MAX_LOCAL_FAILURE_ENTRIES = 10_000;
const SHARED_LOOKUP_REFILL_PER_MS = API_KEY_LOOKUP_BUDGET_PER_SECOND / 1_000;
const LOCAL_LOOKUP_REFILL_PER_MS = API_KEY_LOOKUP_FALLBACK_PER_SECOND / 1_000;

export const API_KEY_LOOKUP_BUDGET_SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local updated_at = tonumber(redis.call('HGET', KEYS[1], 'updated_at'))
if tokens == nil or updated_at == nil then
  tokens = capacity
  updated_at = now
end
tokens = math.min(capacity, tokens + math.max(0, now - updated_at) * refill_per_ms)
updated_at = math.max(now, updated_at)
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', updated_at)
  redis.call('PEXPIRE', KEYS[1], 120000)
  return 1
end
local retry_after_ms = math.ceil((1 - tokens) / refill_per_ms)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', updated_at)
redis.call('PEXPIRE', KEYS[1], 120000)
return -retry_after_ms
`;

interface LocalFailureCount {
  count: number;
  expiresAt: number;
}

export class RedisAuthFailureCounter implements AuthFailureCounterPort {
  private readonly client: RedisIdentityClient | undefined;
  // Every outage counts the metric through the shared reporter; the recovered
  // line waits until BOTH the read and write paths are healthy again, so the
  // log covers the counter as a whole rather than either half.
  private readonly health: RedisHealthReporter;
  private readonly degradedOperations = new Set<'read' | 'write'>();
  private readonly localFailures = new Map<string, LocalFailureCount>();
  // The stricter process-local token bucket used while Redis cannot answer.
  private localLookupBudget: { tokens: number; updatedAt: number } | undefined;
  private readonly now: () => number;

  constructor(
    url: string,
    client?: RedisIdentityClient,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(
      RedisAuthFailureCounter.name,
    ),
    now: () => number = Date.now,
  ) {
    this.client = client ?? connectRedisIdentityClient(url);
    this.now = now;
    this.health = new RedisHealthReporter(
      'auth_failure_counter',
      'API-key authentication and lookup limits',
      logger,
      'using bounded process-local lookup and failure budgets',
    );
  }

  async get(ip: string): Promise<number> {
    if (this.client === undefined) {
      this.health.reportDegraded();
      return this.localFailureCount(ip);
    }

    try {
      const value = await this.client.get(`aihub:v1:authfail:${ip}`);
      const count = Number(value ?? '0');
      const usable = Number.isInteger(count) && count >= 0 ? count : 0;
      this.reportRecovered('read');
      // Keep this worker's failure count as a floor across a Redis outage.
      return Math.max(usable, this.localFailureCount(ip));
    } catch {
      this.reportDegraded('read');
      return this.localFailureCount(ip);
    }
  }

  async recordFailure(ip: string): Promise<number> {
    const client = this.client;
    if (client === undefined) {
      this.health.reportDegraded();
      return this.recordLocalFailure(ip);
    }

    try {
      const key = `aihub:v1:authfail:${ip}`;
      const count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        key,
        AUTH_FAILURE_WINDOW_SECONDS,
      );
      const localCount = this.recordLocalFailure(ip);
      this.reportRecovered('write');
      return Math.max(count, localCount);
    } catch {
      this.reportDegraded('write');
      return this.recordLocalFailure(ip);
    }
  }

  /**
   * Spends one uncached database lookup from the deployment-wide budget. A
   * refusal keeps the caller away from Postgres entirely; a Redis outage
   * spends from the process-local counter instead of failing open.
   */
  async consumeUncachedLookup(): Promise<ApiKeyLookupBudgetDecision> {
    const now = this.now();
    const client = this.client;
    if (client === undefined) {
      this.health.reportDegraded();
      return this.consumeLocalLookupBudget(now);
    }

    try {
      const result = await client.eval(
        API_KEY_LOOKUP_BUDGET_SCRIPT,
        1,
        apiKeyLookupBudgetKey(),
        API_KEY_LOOKUP_BUDGET_BURST,
        SHARED_LOOKUP_REFILL_PER_MS,
      );
      if (result === 1) {
        this.reportRecovered('write');
        return { allowed: true };
      }
      if (Number.isSafeInteger(result) && result < 0) {
        this.reportRecovered('write');
        return {
          allowed: false,
          retryAfterMs: -result,
        };
      }
      throw internalError('API-key lookup budget result is invalid');
    } catch {
      this.reportDegraded('write');
      return this.consumeLocalLookupBudget(now);
    }
  }

  async consumeSandboxKeyLookup(hashHex: string): Promise<boolean> {
    const client = this.client;
    if (client === undefined) {
      this.health.reportDegraded();
      return true;
    }

    try {
      const count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        `aihub:v1:sandbox-key-auth:${hashHex}`,
        60,
      );
      this.reportRecovered('write');
      return count <= SANDBOX_API_KEY_RATE_LIMIT_RPM;
    } catch {
      this.reportDegraded('write');
      return true;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private consumeLocalLookupBudget(now: number): ApiKeyLookupBudgetDecision {
    const previous = this.localLookupBudget;
    const state = previous ?? {
      tokens: API_KEY_LOOKUP_FALLBACK_BURST,
      updatedAt: now,
    };
    state.tokens = Math.min(
      API_KEY_LOOKUP_FALLBACK_BURST,
      state.tokens +
        Math.max(0, now - state.updatedAt) * LOCAL_LOOKUP_REFILL_PER_MS,
    );
    state.updatedAt = Math.max(now, state.updatedAt);
    this.localLookupBudget = state;
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterMs: Math.ceil((1 - state.tokens) / LOCAL_LOOKUP_REFILL_PER_MS),
    };
  }

  private localFailureCount(ip: string): number {
    const entry = this.localFailures.get(ip);
    if (entry === undefined) return 0;
    if (entry.expiresAt <= this.now()) {
      this.localFailures.delete(ip);
      return 0;
    }
    return entry.count;
  }

  private recordLocalFailure(ip: string): number {
    const now = this.now();
    const existing = this.localFailures.get(ip);
    const state =
      existing === undefined || existing.expiresAt <= now
        ? { count: 1, expiresAt: now + AUTH_FAILURE_WINDOW_SECONDS * 1_000 }
        : { count: existing.count + 1, expiresAt: existing.expiresAt };
    putBounded(this.localFailures, ip, state, MAX_LOCAL_FAILURE_ENTRIES);
    const count = state.count;
    return count;
  }

  private reportDegraded(operation: 'read' | 'write'): void {
    this.degradedOperations.add(operation);
    this.health.reportDegraded();
  }

  private reportRecovered(operation: 'read' | 'write'): void {
    if (
      !this.degradedOperations.delete(operation) ||
      this.degradedOperations.size > 0
    ) {
      return;
    }

    this.health.reportRecovered();
  }
}
