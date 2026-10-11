import type { Prisma } from '@prisma-client/client';

import { findActiveAccountId } from './active-account';

describe('findActiveAccountId', () => {
  it('finds an account by exact username and active status', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'usr_1' }]);
    const client = {
      $queryRawUnsafe: query,
    } as unknown as Prisma.TransactionClient;

    await expect(findActiveAccountId(client, 'Operator')).resolves.toBe(
      'usr_1',
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), 'Operator');
  });
});
