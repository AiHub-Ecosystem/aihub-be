import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { OrganizationMembershipPort } from '@/modules/identity/membership/application/organization-membership.port';
import { ListOpenOrganizationInvitations } from './list-open-organization-invitations';
import type {
  OpenOrganizationInvitationRecord,
  OrganizationInvitationPort,
} from './organization-invitation.port';

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-24T12:00:00.000Z'),
  deadlineMs: 5_000,
  userId: 'usr_01J00000000000000000000001',
  environment: 'live',
  organizationId: 'org_acme',
  scopes: [],
});

function invitation(
  id: string,
  createdAt: Date,
): OpenOrganizationInvitationRecord {
  return {
    invitationId: id,
    email: `${id}@example.com`,
    role: 'member',
    invitedByUsername: 'owner',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 86400000),
  };
}

describe('ListOpenOrganizationInvitations', () => {
  let membershipPort: jest.Mocked<
    Pick<OrganizationMembershipPort, 'resolveMembership'>
  >;
  let invitationPort: jest.Mocked<
    Pick<OrganizationInvitationPort, 'listOpenInvitations'>
  >;
  let useCase: ListOpenOrganizationInvitations;

  beforeEach(() => {
    membershipPort = {
      resolveMembership: jest.fn().mockResolvedValue({
        kind: 'active',
        membership: {
          organizationId: 'org_acme',
          userAccountId: 'usr_01J00000000000000000000001',
          role: 'owner',
          status: 'active',
          organizationStatus: 'active',
        },
      }),
    };
    invitationPort = {
      listOpenInvitations: jest.fn().mockResolvedValue([]),
    };
    useCase = new ListOpenOrganizationInvitations(
      membershipPort,
      invitationPort,
    );
  });

  it('queries repository with limit + 1 to detect hasNext', async () => {
    invitationPort.listOpenInvitations.mockResolvedValue([
      invitation('oiv_01', new Date('2026-09-24T12:00:00.000Z')),
    ]);

    const page = await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      now: context.receivedAt,
      limit: 10,
    });

    const call = invitationPort.listOpenInvitations.mock.calls[0]?.[0];
    expect(call?.limit).toBe(11);
    expect(page.invitations).toHaveLength(1);
    expect(page.next).toBeUndefined();
  });

  it('slices to limit and returns next position when more rows exist', async () => {
    const d1 = new Date('2026-09-24T12:00:00.000Z');
    const d2 = new Date('2026-09-24T11:00:00.000Z');
    const d3 = new Date('2026-09-24T10:00:00.000Z');

    invitationPort.listOpenInvitations.mockResolvedValue([
      invitation('oiv_01', d1),
      invitation('oiv_02', d2),
      invitation('oiv_03', d3),
    ]);

    const page = await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      now: context.receivedAt,
      limit: 2,
    });

    expect(page.invitations).toHaveLength(2);
    expect(page.invitations[0]?.invitationId).toBe('oiv_01');
    expect(page.invitations[1]?.invitationId).toBe('oiv_02');
    expect(page.next).toEqual({
      createdAt: d2.toISOString(),
      id: 'oiv_02',
    });
  });

  it('forwards after position to repository', async () => {
    const after = {
      createdAt: new Date('2026-09-24T11:00:00.000Z'),
      id: 'oiv_02',
    };

    await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      now: context.receivedAt,
      after,
      limit: 10,
    });

    const call = invitationPort.listOpenInvitations.mock.calls[0]?.[0];
    expect(call?.after).toEqual(after);
  });
});
