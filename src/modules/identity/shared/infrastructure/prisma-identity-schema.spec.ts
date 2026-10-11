import type { Prisma } from '@prisma-client/client';

describe('Identity Prisma schema', () => {
  it('exposes the Organization creator relation to UserAccount', () => {
    const selection: Prisma.OrganizationSelect = {
      createdByUserAccount: { select: { id: true } },
    };

    expect(selection.createdByUserAccount).toEqual({ select: { id: true } });
  });
});
