import { PostgresQuotaReconciliationRepository } from './postgres-quota-reconciliation.repository';
import type {
  PostgresMeteringClient,
  PostgresTransactionClient,
} from './postgres-usage.repository';

class FakePostgres implements PostgresMeteringClient {
  readonly queries: (readonly unknown[])[] = [];
  rows: readonly unknown[] = [];

  async query<Row extends object = Record<string, unknown>>(
    _text: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.queries.push(values);
    return this.rows as readonly Row[];
  }

  async transaction<T>(
    callback: (client: PostgresTransactionClient) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  async close(): Promise<void> {
    return undefined;
  }
}

describe('PostgresQuotaReconciliationRepository', () => {
  it('maps quota-bearing organizations for the requested UTC window', async () => {
    const client = new FakePostgres();
    client.rows = [
      {
        organization_id: 'org_zulu',
        quota: 2,
        billable_count: 3n,
      },
      {
        organization_id: 'org_alpha',
        quota: 10,
        billable_count: 0n,
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
    expect(client.queries).toEqual([[from, to]]);
  });

  it('rejects an unsafe aggregate before any application write can occur', async () => {
    const client = new FakePostgres();
    client.rows = [
      {
        organization_id: 'org_alpha',
        quota: 10,
        billable_count: 9007199254740992n,
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
