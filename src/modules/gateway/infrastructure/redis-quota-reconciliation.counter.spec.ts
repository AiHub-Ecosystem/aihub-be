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

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

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
  it('reads the current canonical count and treats a missing key as zero', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaReconciliationCounter(redis);
    const request = { organizationId: 'org_alpha', month: '2026-09' };

    await expect(counter.read(request)).resolves.toBe(0);
    redis.values.set(
      quotaKeyForMonth(request.organizationId, request.month),
      '4',
    );
    await expect(counter.read(request)).resolves.toBe(4);
  });

  it.each(['-1', '1.5', '01', '9007199254740992'])(
    'rejects invalid count %s',
    async (value) => {
      const redis = new FakeRedis();
      const counter = new RedisQuotaReconciliationCounter(redis);
      redis.values.set(quotaKeyForMonth('org_alpha', '2026-09'), value);

      await expect(
        counter.read({ organizationId: 'org_alpha', month: '2026-09' }),
      ).rejects.toThrow('Redis quota counter value is invalid');
    },
  );

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

  // The admission guard refuses this value, so the overwrite path must refuse it
  // too: a reconciliation that stored a counter the guard would have rejected
  // would leave the two disagreeing about what the same number means.
  it('refuses a count above the largest exactly representable integer', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaReconciliationCounter(redis);

    await expect(
      counter.overwrite({
        organizationId: 'org_alpha',
        month: '2026-09',
        count: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow('Redis quota counter value is invalid');
    expect(redis.values.size).toBe(0);
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
