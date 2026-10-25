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
        driftedOrganizations: 1,
        driftRequests: 4,
        failed: 1,
      }),
    ).toBe(
      JSON.stringify({
        event: 'quota_reconcile_failed',
        organization_id: 'org_zulu',
        month: '2026-09',
        reconciled: 1,
        over_quota: 0,
        drifted_organizations: 1,
        drift_requests: 4,
        failed: 1,
      }),
    );
    expect(
      formatQuotaReconciliationEvent({
        type: 'summary',
        month: '2026-09',
        summary: {
          reconciled: 2,
          overQuota: 1,
          driftedOrganizations: 1,
          driftRequests: 7,
          failed: 0,
        },
      }),
    ).toBe(
      JSON.stringify({
        event: 'quota_reconcile_summary',
        month: '2026-09',
        reconciled: 2,
        over_quota: 1,
        drifted_organizations: 1,
        drift_requests: 7,
        status: 'attention',
        failed: 0,
      }),
    );
  });

  it('raises attention for drift and over-quota findings but not healthy runs', () => {
    const summary = (overQuota: number, driftRequests: number) =>
      formatQuotaReconciliationEvent({
        type: 'summary',
        month: '2026-09',
        summary: {
          reconciled: 1,
          overQuota,
          driftedOrganizations: driftRequests > 0 ? 1 : 0,
          driftRequests,
          failed: 0,
        },
      });

    expect(summary(0, 0)).toContain('"status":"healthy"');
    expect(summary(0, 2)).toContain('"status":"attention"');
    expect(summary(1, 0)).toContain('"status":"attention"');
  });
});
