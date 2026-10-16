import { isUsableCount } from '@/common/counts/is-usable-count';
import type {
  QuotaCounterOverwritePort,
  QuotaCounterOverwriteRequest,
} from '@/modules/metering/application/quota-reconciliation.port';
import type { RedisGatewayClient } from './redis-gateway.client';
import { QUOTA_TTL_SECONDS, quotaKeyForMonth } from './redis-quota-counter';

export type RedisQuotaReconciliationClient = Pick<
  RedisGatewayClient,
  'set' | 'quit'
>;

export class RedisQuotaReconciliationCounter
  implements QuotaCounterOverwritePort
{
  constructor(private readonly client: RedisQuotaReconciliationClient) {}

  async overwrite(request: QuotaCounterOverwriteRequest): Promise<void> {
    if (!isUsableCount(request.count)) {
      throw new Error('Redis quota counter value is invalid');
    }

    const result = await this.client.set(
      quotaKeyForMonth(request.organizationId, request.month),
      String(request.count),
      'EX',
      QUOTA_TTL_SECONDS,
    );
    if (result !== 'OK') {
      throw new Error('Redis quota counter overwrite failed');
    }
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
