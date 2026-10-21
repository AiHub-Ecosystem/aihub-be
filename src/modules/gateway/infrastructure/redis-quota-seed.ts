import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import type { QuotaUsageSourcePort } from '@/modules/gateway/application/quota-usage-source.port';
import type { RedisGatewayClient } from './redis-gateway.client';
import { QUOTA_TTL_SECONDS, quotaKeyForMonth } from './redis-quota-counter';

// Only the first writer seeds: a counter another request already rebuilt, or
// one reconciliation restored meanwhile, is never overwritten.
const SEED_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') then return 1 end
return 0
`;

const quotaCounterSeeds = new Counter({
  name: 'aihub_quota_counter_seeds_total',
  help: 'Monthly quota counters found missing from Redis, by how the rebuild from durable usage ended.',
  labelNames: ['outcome'],
  registers: [registry],
});

export type QuotaSeedClient = Pick<RedisGatewayClient, 'eval'>;

/**
 * Rebuilds a monthly quota counter that Redis lost from durable usage, so a
 * missing key is never read as zero usage (#371). Concurrent requests in this
 * process share one rebuild; across processes `SET NX` keeps the first.
 */
export class RedisQuotaSeeder {
  private readonly flights = new Map<string, Promise<void>>();

  constructor(
    private readonly client: QuotaSeedClient,
    private readonly source: QuotaUsageSourcePort,
  ) {}

  seed(organizationId: string, now: Date): Promise<void> {
    const period = quotaPeriod(now);
    const key = quotaKeyForMonth(organizationId, period.key);
    const existing = this.flights.get(key);
    if (existing !== undefined) return existing;

    const flight = this.rebuild(key, organizationId, period).finally(() => {
      this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }

  private async rebuild(
    key: string,
    organizationId: string,
    period: { readonly start: Date; readonly end: Date },
  ): Promise<void> {
    try {
      const count = await this.source.billableCount(
        organizationId,
        period.start,
        period.end,
      );
      const written = await this.client.eval(
        SEED_SCRIPT,
        1,
        key,
        String(count),
        String(QUOTA_TTL_SECONDS),
      );
      quotaCounterSeeds.inc({ outcome: written === 1 ? 'seeded' : 'raced' });
    } catch (error) {
      quotaCounterSeeds.inc({ outcome: 'failed' });
      throw error;
    }
  }
}
