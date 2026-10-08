import type { PostgresIdentityQueryClient } from './postgres-identity.client';

import { findActiveAccountId } from './active-account';

class QueryClient implements PostgresIdentityQueryClient {
  readonly calls: {
    readonly sql: string;
    readonly values: readonly unknown[];
  }[] = [];

  constructor(private readonly rows: readonly unknown[]) {}

  async query(
    sql: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    this.calls.push({ sql, values });
    return this.rows;
  }
}

describe('findActiveAccountId', () => {
  it('finds an account by exact username and active status', async () => {
    const client = new QueryClient([{ id: 'usr_1' }]);

    await expect(findActiveAccountId(client, 'Operator')).resolves.toBe(
      'usr_1',
    );
    expect(client.calls[0]?.values).toEqual(['Operator']);
    expect(client.calls[0]?.sql).toContain('WHERE username = $1');
    expect(client.calls[0]?.sql).toContain("status = 'active'");
  });
});
