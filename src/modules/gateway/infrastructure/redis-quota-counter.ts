import { Logger } from '@nestjs/common';

import type {
  QuotaCounterPort,
  QuotaCounterRequest,
} from '../application/quota-counter.port';
import type { RedisGatewayClient } from './redis-gateway.client';

export const QUOTA_TTL_SECONDS = 40 * 24 * 60 * 60;

export type RedisQuotaCounterClient = Pick<
  RedisGatewayClient,
  'get' | 'incr' | 'expire' | 'quit'
>;

interface LoggerLike {
  warn(message: string): void;
  log(message: string): void;
}

export function quotaKeyForMonth(
  organizationId: string,
  month: string,
): string {
  return `aihub:v1:quota:${organizationId}:${month}`;
}

function monthKey(organizationId: string, now: Date): string {
  const month = `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(
    now.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  return quotaKeyForMonth(organizationId, month);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseCount(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('Redis quota counter value is invalid');
  }

  const count = Number(value);
  if (!validCount(count)) {
    throw new Error('Redis quota counter value is invalid');
  }
  return count;
}

function unavailable(): Error {
  return new Error('Redis quota counter is unavailable');
}

export class RedisQuotaCounter implements QuotaCounterPort {
  private readonly client: RedisQuotaCounterClient | undefined;
  private readonly now: () => Date;
  private readonly logger: LoggerLike;
  private redisIsDegraded = false;

  constructor(
    client: RedisQuotaCounterClient | undefined,
    now: () => Date = () => new Date(),
    logger: LoggerLike = new Logger(RedisQuotaCounter.name),
  ) {
    this.client = client;
    this.now = now;
    this.logger = logger;
  }

  async read(request: QuotaCounterRequest): Promise<number> {
    if (this.client === undefined) {
      this.reportDegraded();
      throw unavailable();
    }

    try {
      const value = await this.client.get(
        monthKey(request.organizationId, this.now()),
      );
      const count = value === null ? 0 : parseCount(value);
      this.reportRecovered();
      return count;
    } catch (error) {
      this.reportDegraded();
      throw error;
    }
  }

  async increment(request: QuotaCounterRequest): Promise<void> {
    if (this.client === undefined) {
      this.reportDegraded();
      throw unavailable();
    }

    try {
      const key = monthKey(request.organizationId, this.now());
      const count = await this.client.incr(key);
      if (!validCount(count) || count === 0) {
        throw new Error('Redis quota counter result is invalid');
      }

      const expiry = await this.client.expire(key, QUOTA_TTL_SECONDS);
      if (expiry !== 1) {
        throw new Error('Redis quota counter TTL was not set');
      }

      this.reportRecovered();
    } catch (error) {
      this.reportDegraded();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private reportDegraded(): void {
    if (this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = true;
    this.logger.warn(
      'Redis quota counter unavailable; quota admission will use its configured outage policy',
    );
  }

  private reportRecovered(): void {
    if (!this.redisIsDegraded) {
      return;
    }

    this.redisIsDegraded = false;
    this.logger.log('Redis quota counter recovered');
  }
}
