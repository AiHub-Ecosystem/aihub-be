import { formatQuotaReconciliationEvent } from './quota-reconcile';

describe('formatQuotaReconciliationEvent', () => {
  it('maps successful organization results to the stable JSON boundary', () => {
    expect(
      formatQuotaReconciliationEvent({
        type: 'reconciled',
        result: {
          organizationId: 'org_alpha',
          month: '2026-09',
          billableCount: 3,
          quota: 2,
          overQuota: true,
          excess: 1,
        },
      }),
    ).toBe(
      JSON.stringify({
        event: 'quota_reconciled',
        organization_id: 'org_alpha',
        month: '2026-09',
        billable_count: 3,
        quota: 2,
        over_quota: true,
        excess: 1,
      }),
    );
  });

  it('maps summary and partial-failure events without raw error details', () => {
    expect(
      formatQuotaReconciliationEvent({
        type: 'failed',
        organizationId: 'org_zulu',
        month: '2026-09',
        reconciled: 1,
        overQuota: 0,
        failed: 1,
      }),
    ).toBe(
      JSON.stringify({
        event: 'quota_reconcile_failed',
        organization_id: 'org_zulu',
        month: '2026-09',
        reconciled: 1,
        over_quota: 0,
        failed: 1,
      }),
    );
    expect(
      formatQuotaReconciliationEvent({
        type: 'summary',
        month: '2026-09',
        summary: { reconciled: 2, overQuota: 1, failed: 0 },
      }),
    ).toBe(
      JSON.stringify({
        event: 'quota_reconcile_summary',
        month: '2026-09',
        reconciled: 2,
        over_quota: 1,
        failed: 0,
      }),
    );
  });
});
