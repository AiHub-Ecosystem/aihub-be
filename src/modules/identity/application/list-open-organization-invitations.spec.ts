import { createRequestContext } from '../../../common/request-context/request-context.factory';

import { ListOpenOrganizationInvitations } from './list-open-organization-invitations';
import type {
  ListOpenOrganizationInvitationsInput,
  OrganizationInvitationPort,
} from './organization-invitation.port';
import type { OrganizationMembershipPort } from './organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const FORBIDDEN_MESSAGE = 'Organization invitation access is forbidden';

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

describe('ListOpenOrganizationInvitations', () => {
  let membership: jest.Mocked<
    Pick<OrganizationMembershipPort, 'resolveMembership'>
  >;
  let invitations: jest.Mocked<
    Pick<OrganizationInvitationPort, 'listOpenInvitations'>
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
      listOpenInvitations: jest.fn(
        async (_input: ListOpenOrganizationInvitationsInput) => [
          {
            invitationId: 'oiv_01J00000000000000000000000',
            email: 'invitee@example.com',
            role: 'member' as const,
            invitedByUsername: 'owner',
            createdAt: new Date('2026-09-21T11:00:00.000Z'),
            expiresAt: new Date('2026-09-22T11:00:00.000Z'),
          },
        ],
      ),
    };
  });

  it.each(['owner', 'admin'] as const)(
    'lists actionable invitations for an active %s',
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
      const useCase = new ListOpenOrganizationInvitations(
        membership,
        invitations,
      );

      await expect(
        useCase.list({
          context: context(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          now: NOW,
        }),
      ).resolves.toEqual([
        {
          invitationId: 'oiv_01J00000000000000000000000',
          email: 'invitee@example.com',
          role: 'member',
          invitedByUsername: 'owner',
          createdAt: new Date('2026-09-21T11:00:00.000Z'),
          expiresAt: new Date('2026-09-22T11:00:00.000Z'),
          status: 'pending',
        },
      ]);
      expect(invitations.listOpenInvitations).toHaveBeenCalledWith({
        context: expect.any(Object),
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        now: NOW,
      });
    },
  );

  it.each([
    ['member', 'active', 'active'],
    ['owner', 'disabled', 'active'],
    ['owner', 'active', 'suspended'],
  ] as const)(
    'denies a caller with role=%s, membership=%s, organization=%s',
    async (role, membershipStatus, organizationStatus) => {
      membership.resolveMembership.mockResolvedValue({
        kind: membershipStatus === 'active' ? 'active' : 'disabled',
        membership: {
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          organizationStatus,
          role,
          status: membershipStatus,
        },
      });
      const useCase = new ListOpenOrganizationInvitations(
        membership,
        invitations,
      );

      await expect(
        useCase.list({
          context: context(),
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          now: NOW,
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: FORBIDDEN_MESSAGE,
      });
      expect(invitations.listOpenInvitations).not.toHaveBeenCalled();
    },
  );

  it('denies a missing membership before reading invitations', async () => {
    membership.resolveMembership.mockResolvedValue({ kind: 'missing' });
    const useCase = new ListOpenOrganizationInvitations(
      membership,
      invitations,
    );

    await expect(
      useCase.list({
        context: context(),
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: FORBIDDEN_MESSAGE,
    });
    expect(invitations.listOpenInvitations).not.toHaveBeenCalled();
  });
});
