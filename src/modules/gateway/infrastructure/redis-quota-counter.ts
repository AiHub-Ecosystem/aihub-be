import { internalError } from '@/common/errors/app-error';
import { Logger } from '@nestjs/common';

import { isUsableCount } from '@/common/counts/is-usable-count';
import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import type {
  QuotaCounterPort,
  QuotaCounterRequest,
  QuotaCounterSeedPort,
} from '@/modules/gateway/application/quota-counter.port';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import { safeNonNegativeCount } from '@/modules/metering/public/count-decode';
import type { RedisGatewayClient } from './redis-gateway.client';

export const QUOTA_TTL_SECONDS = 40 * 24 * 60 * 60;

export type RedisQuotaCounterClient = Pick<
  RedisGatewayClient,
  'eval' | 'get' | 'quit'
>;

interface LoggerLike {
  warn(fields: Record<string, unknown>): void;
  log(fields: Record<string, unknown>): void;
}

export function quotaKeyForMonth(
  organizationId: string,
  month: string,
): string {
  return `aihub:v1:quota:${organizationId}:${month}`;
}

function monthKey(organizationId: string, now: Date): string {
  return quotaKeyForMonth(organizationId, quotaPeriod(now).key);
}

function parseCount(value: string): number {
  const count = safeNonNegativeCount(value);
  if (count === undefined || !isUsableCount(count)) {
    throw internalError('Redis quota counter value is invalid');
  }
  return count;
}

function unavailable(): Error {
  return internalError('Redis quota counter is unavailable');
}

// Incrementing a missing counter would restart it at 1 and hide the month's
// usage; only a seeded or reconciled counter is incremented (#371).
const INCREMENT_EXISTING_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
return redis.call('INCR', KEYS[1])
`;

export class RedisQuotaCounter implements QuotaCounterPort {
  private readonly client: RedisQuotaCounterClient | undefined;
  private readonly now: () => Date;
  private readonly health: RedisHealthReporter;

  constructor(
    client: RedisQuotaCounterClient | undefined,
    now: () => Date = () => new Date(),
    logger: LoggerLike = new Logger(RedisQuotaCounter.name),
    private readonly seeder?: QuotaCounterSeedPort,
  ) {
    this.client = client;
    this.now = now;
    this.health = new RedisHealthReporter(
      'quota',
      'quota counter',
      logger,
      'quota admission will use its configured outage policy',
    );
  }

  async read(request: QuotaCounterRequest): Promise<number> {
    if (this.client === undefined) {
      this.health.reportDegraded();
      throw unavailable();
    }

    try {
      const key = monthKey(request.organizationId, this.now());
      let value = await this.client.get(key);
      // A missing counter is not zero usage: rebuild it from durable usage,
      // or let the caller treat the quota as unverified.
      if (value === null && this.seeder !== undefined) {
        await this.seeder.seed(request.organizationId, this.now());
        value = await this.client.get(key);
      }
      if (value === null) {
        throw internalError('Redis quota counter is missing');
      }
      const count = parseCount(value);
      this.health.reportRecovered();
      return count;
    } catch (error) {
      this.health.reportDegraded();
      throw error;
    }
  }

  async increment(request: QuotaCounterRequest): Promise<void> {
    if (this.client === undefined) {
      this.health.reportDegraded();
      throw unavailable();
    }

    const client = this.client;
    try {
      const key = monthKey(
        request.organizationId,
        request.occurredAt ?? this.now(),
      );
      const count = await client.eval(INCREMENT_EXISTING_SCRIPT, 1, key);
      if (count === 0) {
        throw internalError('Redis quota counter is missing');
      }
      if (!isUsableCount(count)) {
        throw internalError('Redis quota counter result is invalid');
      }

      this.health.reportRecovered();
    } catch (error) {
      this.health.reportDegraded();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
