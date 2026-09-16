import { QUOTA_TTL_SECONDS, quotaKeyForMonth } from './redis-quota-counter';
import {
  type RedisQuotaReconciliationClient,
  RedisQuotaReconciliationCounter,
} from './redis-quota-reconciliation.counter';

class FakeRedis implements RedisQuotaReconciliationClient {
  readonly values = new Map<string, string>();
  readonly calls: Array<{
    readonly key: string;
    readonly value: string;
    readonly mode: 'EX';
    readonly seconds: number;
  }> = [];
  result: string | null = 'OK';

  async set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<string | null> {
    this.calls.push({ key, value, mode, seconds });
    if (this.result === 'OK') {
      this.values.set(key, value);
    }
    return this.result;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

describe('RedisQuotaReconciliationCounter', () => {
  it('overwrites zero with the canonical organization-month key and 40-day TTL', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaReconciliationCounter(redis);

    await counter.overwrite({
      organizationId: 'org_alpha',
      month: '2026-09',
      count: 0,
    });

    expect(redis.values.get(quotaKeyForMonth('org_alpha', '2026-09'))).toBe(
      '0',
    );
    expect(redis.calls).toEqual([
      {
        key: 'aihub:v1:quota:org_alpha:2026-09',
        value: '0',
        mode: 'EX',
        seconds: QUOTA_TTL_SECONDS,
      },
    ]);
  });

  it('is idempotent across adapter instances sharing persistent Redis state', async () => {
    const redis = new FakeRedis();
    const request = {
      organizationId: 'org_alpha',
      month: '2026-09',
      count: 4,
    } as const;

    await new RedisQuotaReconciliationCounter(redis).overwrite(request);
    await new RedisQuotaReconciliationCounter(redis).overwrite(request);

    expect(
      redis.values.get(quotaKeyForMonth(request.organizationId, request.month)),
    ).toBe('4');
  });

  it('surfaces a failed SET without pretending the key was repaired', async () => {
    const redis = new FakeRedis();
    redis.result = null;
    const counter = new RedisQuotaReconciliationCounter(redis);

    await expect(
      counter.overwrite({
        organizationId: 'org_alpha',
        month: '2026-09',
        count: 1,
      }),
    ).rejects.toThrow('Redis quota counter overwrite failed');
    expect(redis.values.size).toBe(0);
  });
});
