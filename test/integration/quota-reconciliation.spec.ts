import {
  type RedisQuotaReconciliationClient,
  RedisQuotaReconciliationCounter,
} from '@/modules/gateway/infrastructure/redis-quota-reconciliation.counter';
import type {
  QuotaCounterOverwritePort,
  QuotaOrganizationSnapshot,
  QuotaReconciliationSnapshotPort,
  QuotaReconciliationTarget,
} from '@/modules/metering/application/billing/quota-reconciliation.port';
import {
  type QuotaReconciliationEvent,
  QuotaReconciliationService,
} from '@/modules/metering/public/quota-reconciliation';

class InMemoryRedis implements RedisQuotaReconciliationClient {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode: 'EX',
    _seconds: number,
  ): Promise<string> {
    this.values.set(key, value);
    return 'OK';
  }

  async quit(): Promise<void> {}
}

describe('quota reconciliation after Redis state reset', () => {
  it('rebuilds a missing active-period counter from durable usage and stays idempotent', async () => {
    const redis = new InMemoryRedis();
    const counter: QuotaCounterOverwritePort =
      new RedisQuotaReconciliationCounter(redis);
    const snapshot: QuotaOrganizationSnapshot = {
      organizationId: 'org_alpha',
      monthlyRequestQuota: 100,
      billableRequestCount: 3,
    };
    const source: QuotaReconciliationSnapshotPort = {
      async list(_target: QuotaReconciliationTarget) {
        return [snapshot];
      },
    };
    const service = new QuotaReconciliationService(
      source,
      counter,
      () => new Date('2026-09-16T12:00:00.000Z'),
    );
    const events: QuotaReconciliationEvent[] = [];

    await expect(
      service.reconcile('2026-09', (event) => events.push(event), {
        driftThresholdAbs: 0,
        driftThresholdFraction: 0.05,
      }),
    ).resolves.toMatchObject({ driftedOrganizations: 1, driftRequests: 3 });
    await expect(
      service.reconcile('2026-09', undefined, {
        driftThresholdAbs: 0,
        driftThresholdFraction: 0.05,
      }),
    ).resolves.toMatchObject({ driftedOrganizations: 0, driftRequests: 0 });

    expect(redis.values.get('aihub:v1:quota:org_alpha:2026-09')).toBe('3');
    const correction = events.find((event) => event.type === 'drift_corrected');
    expect(correction).toMatchObject({
      type: 'drift_corrected',
      organizationId: 'org_alpha',
      month: '2026-09',
      postgresCount: 3,
      redisCount: 0,
      driftRequests: 3,
    });
    const thresholdRequests =
      correction?.type === 'drift_corrected'
        ? correction.thresholdRequests
        : Number.NaN;
    expect(thresholdRequests).toBeCloseTo(0.15);
  });
});
