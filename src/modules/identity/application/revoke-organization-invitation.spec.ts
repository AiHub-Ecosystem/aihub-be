import { AppError } from '@/common/errors/app-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';

import type {
  OrganizationInvitationPort,
  RevokeOrganizationInvitationInput,
  RevokeOrganizationInvitationResult,
} from './organization-invitation.port';
import type { OrganizationMembershipPort } from './organization-membership.port';
import { RevokeOrganizationInvitation } from './revoke-organization-invitation';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const INVITATION_ID = 'oiv_01J00000000000000000000000';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const FORBIDDEN_MESSAGE = 'Organization invitation revocation is forbidden';

type CallerOverride = {
  readonly role?: 'owner' | 'admin' | 'member';
  readonly status?: 'active' | 'disabled';
  readonly organizationStatus?: 'active' | 'suspended';
};

function context() {
  return createRequestContext({
    requestId: 'req_01J00000000000000000000000',
    receivedAt: NOW,
    deadlineMs: 5_000,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    scopes: [],
  });
}

function command(overrides: Partial<RevokeOrganizationInvitationInput> = {}) {
  return {
    context: context(),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    invitationId: INVITATION_ID,
    ...overrides,
  };
}

describe('RevokeOrganizationInvitation', () => {
  let membership: jest.Mocked<
    Pick<OrganizationMembershipPort, 'resolveMembership'>
  >;
  let invitations: jest.Mocked<
    Pick<OrganizationInvitationPort, 'revokeInvitation'>
  >;

  beforeEach(() => {
    membership = {
      resolveMembership: jest.fn(async ({ organizationId, userId }) => ({
        kind: 'active' as const,
        membership: {
          organizationId,
          userId,
          organizationStatus: 'active' as const,
          role: 'owner' as const,
          status: 'active' as const,
        },
      })),
    };
    invitations = {
      revokeInvitation: jest.fn(
        async (
          _input: RevokeOrganizationInvitationInput,
        ): Promise<RevokeOrganizationInvitationResult> => ({
          kind: 'closed',
        }),
      ),
    };
  });

  it.each(['owner', 'admin'] as const)(
    'closes an invitation for an active %s caller',
    async (role) => {
      membership.resolveMembership.mockResolvedValue({
        kind: 'active',
        membership: {
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          organizationStatus: 'active',
          role,
          status: 'active',
        },
      });
      const useCase = new RevokeOrganizationInvitation(
        membership,
        invitations,
        () => NOW,
      );

      await expect(useCase.revoke(command())).resolves.toBeUndefined();
      expect(invitations.revokeInvitation).toHaveBeenCalledWith({
        context: expect.any(Object),
        actorUserId: USER_ID,
        actorRole: role,
        organizationId: ORGANIZATION_ID,
        invitationId: INVITATION_ID,
        now: NOW,
      });
    },
  );

  it('maps an unknown invitation to NOT_FOUND', async () => {
    invitations.revokeInvitation.mockResolvedValue({ kind: 'not_found' });
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps an unknown invitation behind the member policy denial', async () => {
    membership.resolveMembership.mockResolvedValue({
      kind: 'active',
      membership: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        organizationStatus: 'active',
        role: 'member',
        status: 'active',
      },
    });
    invitations.revokeInvitation.mockResolvedValue({ kind: 'not_found' });
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
  });

  it('maps a concurrent organization suspension to the safe policy denial', async () => {
    invitations.revokeInvitation.mockResolvedValue({
      kind: 'organization_suspended',
    });
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
  });

  it.each<[string, CallerOverride]>([
    ['a disabled membership', { status: 'disabled' as const }],
    ['a suspended organization', { organizationStatus: 'suspended' as const }],
  ])('denies %s before reading the invitation', async (_label, overrides) => {
    membership.resolveMembership.mockResolvedValue({
      kind: overrides.status === 'disabled' ? 'disabled' : 'active',
      membership: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        organizationStatus: overrides.organizationStatus ?? 'active',
        role: overrides.role ?? 'owner',
        status: overrides.status ?? 'active',
      },
    });
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
    expect(invitations.revokeInvitation).not.toHaveBeenCalled();
  });

  it('passes an active member to the repository so a real target denial can be audited', async () => {
    membership.resolveMembership.mockResolvedValue({
      kind: 'active',
      membership: {
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        organizationStatus: 'active',
        role: 'member',
        status: 'active',
      },
    });
    invitations.revokeInvitation.mockRejectedValue(
      new AppError({
        code: 'FORBIDDEN',
        message: FORBIDDEN_MESSAGE,
        retryable: false,
      }),
    );
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
    expect(invitations.revokeInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: 'member' }),
    );
  });

  it('denies a missing membership before reading the invitation', async () => {
    membership.resolveMembership.mockResolvedValue({ kind: 'missing' });
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
    expect(invitations.revokeInvitation).not.toHaveBeenCalled();
  });

  it('preserves a target authorization error from the repository', async () => {
    invitations.revokeInvitation.mockRejectedValue(
      new AppError({
        code: 'FORBIDDEN',
        message: FORBIDDEN_MESSAGE,
        retryable: false,
      }),
    );
    const useCase = new RevokeOrganizationInvitation(
      membership,
      invitations,
      () => NOW,
    );

    await expect(useCase.revoke(command())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
  });
});
