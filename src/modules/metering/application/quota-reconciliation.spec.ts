import {
  InvalidQuotaReconciliationMonthError,
  type QuotaReconciliationEvent,
  QuotaReconciliationService,
} from './quota-reconciliation';
import type {
  QuotaCounterOverwritePort,
  QuotaCounterOverwriteRequest,
  QuotaOrganizationSnapshot,
  QuotaReconciliationSnapshotPort,
  QuotaReconciliationTarget,
} from './quota-reconciliation.port';

class FakeSnapshotPort implements QuotaReconciliationSnapshotPort {
  readonly targets: QuotaReconciliationTarget[] = [];

  constructor(
    private readonly snapshots: readonly QuotaOrganizationSnapshot[],
  ) {}

  async list(
    target: QuotaReconciliationTarget,
  ): Promise<readonly QuotaOrganizationSnapshot[]> {
    this.targets.push(target);
    return this.snapshots;
  }
}

class FakeCounter implements QuotaCounterOverwritePort {
  readonly values = new Map<string, number>();
  readonly writes: QuotaCounterOverwriteRequest[] = [];
  failOrganizationId: string | undefined;

  async overwrite(request: QuotaCounterOverwriteRequest): Promise<void> {
    if (request.organizationId === this.failOrganizationId) {
      throw new Error('redis down');
    }
    this.writes.push(request);
    this.values.set(
      `${request.organizationId}:${request.month}`,
      request.count,
    );
  }
}

describe('QuotaReconciliationService', () => {
  const currentMonth = new Date('2026-09-16T21:00:00.000Z');
  const now = () => new Date(currentMonth.getTime());

  it('captures one UTC half-open window for the current month', async () => {
    const source = new FakeSnapshotPort([]);
    const counter = new FakeCounter();
    const service = new QuotaReconciliationService(source, counter, now);

    await expect(service.reconcile()).resolves.toEqual({
      reconciled: 0,
      overQuota: 0,
      failed: 0,
    });
    expect(source.targets).toEqual([
      {
        month: '2026-09',
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);
  });

  it.each(['2026-13', '2026-00', '2026-9', '2027-01'])(
    'rejects invalid target month %s before reading usage',
    async (month) => {
      const source = new FakeSnapshotPort([]);
      const service = new QuotaReconciliationService(
        source,
        new FakeCounter(),
        now,
      );

      await expect(service.reconcile(month)).rejects.toBeInstanceOf(
        InvalidQuotaReconciliationMonthError,
      );
      expect(source.targets).toHaveLength(0);
    },
  );

  it('accepts the current month and preceding twelve calendar months across a year boundary', async () => {
    const source = new FakeSnapshotPort([]);
    const counter = new FakeCounter();
    const service = new QuotaReconciliationService(
      source,
      counter,
      () => new Date('2026-01-01T00:00:00.000Z'),
    );

    await service.reconcile('2025-01');
    expect(source.targets[0]?.month).toBe('2025-01');
    await expect(service.reconcile('2024-12')).rejects.toBeInstanceOf(
      InvalidQuotaReconciliationMonthError,
    );
  });

  it('skips unlimited organizations, writes zeroes, and reports strict overages in order', async () => {
    const source = new FakeSnapshotPort([
      {
        organizationId: 'org_zulu',
        monthlyRequestQuota: 2,
        billableRequestCount: 3,
      },
      {
        organizationId: 'org_unlimited',
        monthlyRequestQuota: null,
        billableRequestCount: 99,
      },
      {
        organizationId: 'org_alpha',
        monthlyRequestQuota: 10,
        billableRequestCount: 0,
      },
    ]);
    const counter = new FakeCounter();
    const events: QuotaReconciliationEvent[] = [];
    const service = new QuotaReconciliationService(source, counter, now);

    await service.reconcile('2026-09', (event) => events.push(event));

    expect(counter.writes).toEqual([
      { organizationId: 'org_alpha', month: '2026-09', count: 0 },
      { organizationId: 'org_zulu', month: '2026-09', count: 3 },
    ]);
    expect(events).toEqual([
      {
        type: 'reconciled',
        result: {
          organizationId: 'org_alpha',
          month: '2026-09',
          billableCount: 0,
          quota: 10,
          overQuota: false,
          excess: 0,
        },
      },
      {
        type: 'reconciled',
        result: {
          organizationId: 'org_zulu',
          month: '2026-09',
          billableCount: 3,
          quota: 2,
          overQuota: true,
          excess: 1,
        },
      },
      {
        type: 'summary',
        month: '2026-09',
        summary: { reconciled: 2, overQuota: 1, failed: 0 },
      },
    ]);
  });

  it('reruns idempotently against persistent counter state', async () => {
    const source = new FakeSnapshotPort([
      {
        organizationId: 'org_alpha',
        monthlyRequestQuota: 10,
        billableRequestCount: 4,
      },
    ]);
    const counter = new FakeCounter();
    const service = new QuotaReconciliationService(source, counter, now);

    await service.reconcile('2026-09');
    await service.reconcile('2026-09');

    expect(counter.values.get('org_alpha:2026-09')).toBe(4);
    expect(counter.writes).toHaveLength(2);
    expect(counter.writes[0]).toEqual(counter.writes[1]);
  });

  it('leaves earlier writes in place and emits a safe partial-failure event', async () => {
    const source = new FakeSnapshotPort([
      {
        organizationId: 'org_alpha',
        monthlyRequestQuota: 10,
        billableRequestCount: 1,
      },
      {
        organizationId: 'org_zulu',
        monthlyRequestQuota: 10,
        billableRequestCount: 2,
      },
    ]);
    const counter = new FakeCounter();
    counter.failOrganizationId = 'org_zulu';
    const events: QuotaReconciliationEvent[] = [];
    const service = new QuotaReconciliationService(source, counter, now);

    await expect(
      service.reconcile('2026-09', (event) => events.push(event)),
    ).rejects.toThrow('quota reconciliation failed');

    expect(counter.writes).toEqual([
      { organizationId: 'org_alpha', month: '2026-09', count: 1 },
    ]);
    expect(events).toEqual([
      {
        type: 'reconciled',
        result: {
          organizationId: 'org_alpha',
          month: '2026-09',
          billableCount: 1,
          quota: 10,
          overQuota: false,
          excess: 0,
        },
      },
      {
        type: 'failed',
        organizationId: 'org_zulu',
        month: '2026-09',
        reconciled: 1,
        overQuota: 0,
        failed: 1,
      },
    ]);
  });

  it('does not write when the durable snapshot read fails', async () => {
    const source: QuotaReconciliationSnapshotPort = {
      list: async () => {
        throw new Error('database down');
      },
    };
    const counter = new FakeCounter();
    const service = new QuotaReconciliationService(source, counter, now);

    await expect(service.reconcile('2026-09')).rejects.toThrow(
      'quota reconciliation read failed',
    );
    expect(counter.writes).toHaveLength(0);
  });
});
