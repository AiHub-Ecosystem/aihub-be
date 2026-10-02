import { AppError } from '@/common/errors/app-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { ManageOrganizationMembership } from './manage-organization-membership';
import type { OrganizationMembershipPort } from './organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-21T00:00:00.000Z'),
  deadlineMs: 5_000,
  userId: USER_ID,
  organizationId: ORGANIZATION_ID,
  scopes: [],
});

function input(username = 'bob') {
  return {
    context,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    username,
  } as const;
}

function membershipWith(
  role: 'owner' | 'admin' | 'member' = 'owner',
  organizationStatus: 'active' | 'suspended' = 'active',
): jest.Mocked<OrganizationMembershipPort> {
  return {
    resolveMembership: jest.fn(async (_input) => ({
      kind: 'active' as const,
      membership: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        organizationStatus,
        role,
        status: 'active' as const,
      },
    })),
    listRoster: jest.fn(),
    changeRole: jest.fn(async (request) => ({
      organizationId: request.organizationId,
      username: request.username,
      role: request.role,
      status: 'active' as const,
    })),
    disable: jest.fn(async (request) => ({
      organizationId: request.organizationId,
      username: request.username,
      role: 'member' as const,
      status: 'disabled' as const,
    })),
    transfer: jest.fn(async (request) => ({
      organizationId: request.organizationId,
      username: request.username,
      role: 'owner' as const,
      status: 'active' as const,
    })),
  };
}

describe('ManageOrganizationMembership', () => {
  it('delegates role authority to the transaction-aware membership port', async () => {
    const membership = membershipWith('member');
    const manager = new ManageOrganizationMembership(membership);

    await expect(
      manager.changeRole({ ...input(), role: 'admin' }),
    ).resolves.toMatchObject({ role: 'admin' });
    expect(membership.changeRole).toHaveBeenCalled();
  });

  it('delegates transfer authority to the transaction-aware membership port', async () => {
    const membership = membershipWith('admin');
    const manager = new ManageOrganizationMembership(membership);

    await expect(manager.transfer(input())).resolves.toMatchObject({
      role: 'owner',
    });
    expect(membership.transfer).toHaveBeenCalled();
  });

  it('forbids every mutation against a suspended organization', async () => {
    const membership = membershipWith('owner', 'suspended');
    const manager = new ManageOrganizationMembership(membership);

    await expect(manager.disable(input())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(membership.disable).not.toHaveBeenCalled();
  });

  it('lets an authorized owner change a role and preserves the result', async () => {
    const membership = membershipWith('owner');
    const manager = new ManageOrganizationMembership(membership);

    await expect(
      manager.changeRole({ ...input(), role: 'member' }),
    ).resolves.toEqual({
      organizationId: ORGANIZATION_ID,
      username: 'bob',
      role: 'member',
      status: 'active',
    });
    expect(membership.changeRole).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'member' }),
    );
  });

  it('preserves durable lookup failures instead of authorizing', async () => {
    const membership = membershipWith('owner');
    const failure = new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Identity store is unavailable',
      retryable: false,
    });
    membership.resolveMembership.mockRejectedValue(failure);
    const manager = new ManageOrganizationMembership(membership);

    await expect(manager.disable(input())).rejects.toBe(failure);
    expect(membership.disable).not.toHaveBeenCalled();
  });
});
