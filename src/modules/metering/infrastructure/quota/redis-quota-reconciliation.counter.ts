import { isUsableCount } from '@/common/counts/is-usable-count';
import { internalError } from '@/common/errors/app-error';
import type {
  QuotaCounterOverwritePort,
  QuotaCounterOverwriteRequest,
  QuotaCounterReadRequest,
} from '@/modules/metering/application/quota/quota-counter.port';
import { quotaKeyForMonth } from '@/modules/metering/application/quota/quota-key';
import type { RedisMeteringClient } from './redis-metering.client';
import { QUOTA_TTL_SECONDS } from './redis-quota-counter';

export type RedisQuotaReconciliationClient = Pick<
  RedisMeteringClient,
  'get' | 'set' | 'quit'
>;

export class RedisQuotaReconciliationCounter
  implements QuotaCounterOverwritePort
{
  constructor(
    private readonly client: RedisQuotaReconciliationClient | undefined,
  ) {}

  async read(request: QuotaCounterReadRequest): Promise<number> {
    if (this.client === undefined) {
      throw internalError('Redis quota counter is unavailable');
    }
    const value = await this.client.get(
      quotaKeyForMonth(request.organizationId, request.month),
    );
    if (value === null) return 0;

    const count = Number(value);
    if (!/^(0|[1-9]\d*)$/.test(value) || !isUsableCount(count)) {
      throw internalError('Redis quota counter value is invalid');
    }
    return count;
  }

  async overwrite(request: QuotaCounterOverwriteRequest): Promise<void> {
    if (this.client === undefined) {
      throw internalError('Redis quota counter is unavailable');
    }
    if (!isUsableCount(request.count)) {
      throw internalError('Redis quota counter value is invalid');
    }

    const result = await this.client.set(
      quotaKeyForMonth(request.organizationId, request.month),
      String(request.count),
      'EX',
      QUOTA_TTL_SECONDS,
    );
    if (result !== 'OK') {
      throw internalError('Redis quota counter overwrite failed');
    }
  }

  async close(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
