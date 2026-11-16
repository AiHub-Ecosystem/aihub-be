import { type Prisma, type PrismaClient } from '@prisma-client/client';

import { organizationTransaction } from './organization-transaction';

function fakeClient() {
  const queryRaw = jest.fn(async (..._args: unknown[]) => [
    { set_config: 'org_a' },
  ]);
  let outcome: 'committed' | 'rolled back' | undefined;
  const transaction = jest.fn(
    async (
      callback: (client: Prisma.TransactionClient) => Promise<unknown>,
      _options?: unknown,
    ) => {
      try {
        const result = await callback({
          $queryRawUnsafe: queryRaw,
        } as unknown as Prisma.TransactionClient);
        outcome = 'committed';
        return result;
      } catch (error) {
        outcome = 'rolled back';
        throw error;
      }
    },
  );
  const client = {
    $transaction: transaction,
  } as unknown as PrismaClient;
  return { client, queryRaw, transaction, outcome: () => outcome };
}

describe('organizationTransaction', () => {
  it('sets the Organization inside the transaction before the callback runs', async () => {
    const { client, queryRaw, outcome } = fakeClient();
    const order: string[] = [];
    queryRaw.mockImplementation(async (..._args: unknown[]) => {
      order.push('set_config');
      return [{ set_config: 'org_a' }];
    });

    const result = await organizationTransaction(client, 'org_a', async () => {
      order.push('callback');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['set_config', 'callback']);
    expect(queryRaw).toHaveBeenCalledWith(
      'SELECT set_config($1, $2, true)',
      'aihub.organization_id',
      'org_a',
    );
    expect(outcome()).toBe('committed');
  });

  it('rolls back and does not run the callback when the tenant setting fails', async () => {
    const { client, queryRaw, outcome } = fakeClient();
    queryRaw.mockImplementation(async () => {
      throw new Error('set_config failed');
    });
    const callback = jest.fn();

    await expect(
      organizationTransaction(client, 'org_a', callback),
    ).rejects.toThrow('set_config failed');
    expect(callback).not.toHaveBeenCalled();
    expect(outcome()).toBe('rolled back');
  });

  it('refuses an empty Organization without opening a transaction', async () => {
    const { client, transaction } = fakeClient();

    expect(() => organizationTransaction(client, '   ', async () => 1)).toThrow(
      'Organization identity is required',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('gives the callback a guarded transaction handle', async () => {
    const { client } = fakeClient();
    const handle = await organizationTransaction(
      client,
      'org_a',
      async (tx) => tx,
    );
    expect(
      typeof (handle as { $queryRawUnsafe?: unknown }).$queryRawUnsafe,
    ).toBe('function');
  });
});
