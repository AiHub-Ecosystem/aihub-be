import { nextQuotaReconciliationDelay } from './quota-reconciliation.scheduler';

describe('quota reconciliation schedule', () => {
  const intervalMs = 5 * 60 * 1000;

  it('aligns its first run to an interval boundary from the UTC quota-period start', () => {
    expect(
      nextQuotaReconciliationDelay(
        new Date('2026-09-16T12:03:00.000Z'),
        intervalMs,
      ),
    ).toBe(2 * 60 * 1000);
  });

  it('waits a full interval at a boundary instead of replaying a missed run', () => {
    expect(
      nextQuotaReconciliationDelay(
        new Date('2026-09-01T00:10:00.000Z'),
        intervalMs,
      ),
    ).toBe(intervalMs);
  });
});
