import { billableRequestSql } from './billable-request-sql';
import { BILLING_USAGE_SQL } from './postgres-billing-statement.repository';
import { MONTHLY_BILLABLE_USAGE_SQL } from './postgres-monthly-billable-usage';
import { QUOTA_RECONCILIATION_SQL } from './postgres-quota-reconciliation.repository';
import { USAGE_REPORT_SQL } from './postgres-usage-completeness-report.repository';

describe('billableRequestSql', () => {
  it('states a billable request as a successful row that counts once', () => {
    expect(billableRequestSql()).toBe(
      "outcome = 'success' AND billable_requests = 1",
    );
    expect(billableRequestSql('u')).toBe(
      "u.outcome = 'success' AND u.billable_requests = 1",
    );
  });

  it.each([
    ['monthly usage', MONTHLY_BILLABLE_USAGE_SQL, billableRequestSql()],
    ['quota reconciliation', QUOTA_RECONCILIATION_SQL, billableRequestSql('u')],
    ['completeness report', USAGE_REPORT_SQL, billableRequestSql()],
    ['billing statement', BILLING_USAGE_SQL, billableRequestSql()],
  ])(
    '%s counts billable requests through the shared statement',
    (_, sql, predicate) => {
      expect(sql).toContain(predicate);
      expect(sql).not.toMatch(/SUM\(\s*u?\.?billable_requests/);
    },
  );
});
