import {
  PostgresQuotaReconciliationRepository,
  QUOTA_RECONCILIATION_SQL,
} from './postgres-quota-reconciliation.repository';
import type { PostgresMeteringClient } from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];
  rows: readonly unknown[] = [];

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return this.rows;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

describe('PostgresQuotaReconciliationRepository', () => {
  it('queries the UTC half-open window and maps quota-bearing organizations', async () => {
    const client = new FakePostgres();
    client.rows = [
      {
        organization_id: 'org_zulu',
        quota: 2,
        billable_count: '3',
      },
      {
        organization_id: 'org_alpha',
        quota: '10',
        billable_count: '0',
      },
    ];
    const repository = new PostgresQuotaReconciliationRepository(client);
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-10-01T00:00:00.000Z');

    await expect(
      repository.list({ month: '2026-09', from, to }),
    ).resolves.toEqual([
      {
        organizationId: 'org_alpha',
        monthlyRequestQuota: 10,
        billableRequestCount: 0,
      },
      {
        organizationId: 'org_zulu',
        monthlyRequestQuota: 2,
        billableRequestCount: 3,
      },
    ]);
    expect(client.queries).toEqual([
      { text: QUOTA_RECONCILIATION_SQL, values: [from, to] },
    ]);
  });

  it('keeps successful quota-unverified rows billable and excludes failed rows in SQL', () => {
    expect(QUOTA_RECONCILIATION_SQL).toContain(
      "FILTER (WHERE u.outcome = 'success')",
    );
    expect(QUOTA_RECONCILIATION_SQL).toContain('SUM(u.billable_requests)');
    expect(QUOTA_RECONCILIATION_SQL).toContain('u.created_at >= $1');
    expect(QUOTA_RECONCILIATION_SQL).toContain('u.created_at < $2');
    expect(QUOTA_RECONCILIATION_SQL).toContain(
      'o.monthly_request_quota IS NOT NULL',
    );
    expect(QUOTA_RECONCILIATION_SQL).not.toContain('o.status');
    expect(QUOTA_RECONCILIATION_SQL).not.toContain('metering_status');
  });

  it('rejects an unsafe aggregate before any application write can occur', async () => {
    const client = new FakePostgres();
    client.rows = [
      {
        organization_id: 'org_alpha',
        quota: 10,
        billable_count: '9007199254740992',
      },
    ];
    const repository = new PostgresQuotaReconciliationRepository(client);

    await expect(
      repository.list({
        month: '2026-09',
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow('quota reconciliation field billable_count is invalid');
  });
});
