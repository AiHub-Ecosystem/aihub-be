import type { IdentityDatabase } from './postgres-identity.client';
import { checkPostgresIdentityDatabase } from './postgres-readiness';

describe('checkPostgresIdentityDatabase', () => {
  it('checks the existing Drizzle pool with the supplied timeout', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const database = { $client: { query } } as unknown as IdentityDatabase;

    await checkPostgresIdentityDatabase(database, 'postgres://db', 750);

    expect(query).toHaveBeenCalledWith({
      text: 'SELECT 1',
      query_timeout: 750,
    });
  });

  it('fails without touching the pool when the database is unconfigured', async () => {
    const query = jest.fn();
    const database = { $client: { query } } as unknown as IdentityDatabase;

    await expect(
      checkPostgresIdentityDatabase(database, undefined, 750),
    ).rejects.toThrow('PostgreSQL is not configured');

    expect(query).not.toHaveBeenCalled();
  });
});
