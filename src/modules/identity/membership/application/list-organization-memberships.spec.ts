import { createRequestContext } from '@/common/request-context/request-context.factory';
import { ListOrganizationMemberships } from './list-organization-memberships';
import type {
  ListedOrganizationMember,
  OrganizationMembershipListPort,
} from './organization-membership-list.port';

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-24T12:00:00.000Z'),
  deadlineMs: 5_000,
  userId: 'usr_01J00000000000000000000001',
  environment: 'live',
  organizationId: 'org_acme',
  scopes: [],
});

function member(username: string): ListedOrganizationMember {
  return {
    username,
    role: 'member',
    status: 'active',
  };
}

describe('ListOrganizationMemberships', () => {
  let membershipPort: jest.Mocked<OrganizationMembershipListPort>;
  let useCase: ListOrganizationMemberships;

  beforeEach(() => {
    membershipPort = {
      listOrganizationMembers: jest.fn(),
    };
    useCase = new ListOrganizationMemberships(membershipPort);
  });

  it('requests limit + 1 rows from the port to detect next page', async () => {
    membershipPort.listOrganizationMembers.mockResolvedValue({
      kind: 'authorized',
      members: [member('alice'), member('bob')],
    });

    const result = await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      limit: 10,
    });

    expect(membershipPort.listOrganizationMembers.mock.calls[0]?.[0]).toEqual({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      limit: 11,
    });
    expect(result.members).toHaveLength(2);
    expect(result.next).toBeUndefined();
  });

  it('passes after position to the port when provided', async () => {
    membershipPort.listOrganizationMembers.mockResolvedValue({
      kind: 'authorized',
      members: [member('carol')],
    });

    await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      after: 'bob',
      limit: 5,
    });

    expect(membershipPort.listOrganizationMembers.mock.calls[0]?.[0]).toEqual({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      after: 'bob',
      limit: 6,
    });
  });

  it('returns next cursor username and trims to limit when limit + 1 rows exist', async () => {
    membershipPort.listOrganizationMembers.mockResolvedValue({
      kind: 'authorized',
      members: [member('alice'), member('bob'), member('carol')],
    });

    const result = await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      limit: 2,
    });

    expect(result.members).toHaveLength(2);
    expect(result.members.map((m) => m.username)).toEqual(['alice', 'bob']);
    expect(result.next).toBe('bob');
  });

  it('returns no next cursor when rows length is exactly limit', async () => {
    membershipPort.listOrganizationMembers.mockResolvedValue({
      kind: 'authorized',
      members: [member('alice'), member('bob')],
    });

    const result = await useCase.list({
      context,
      userId: 'usr_01J00000000000000000000001',
      organizationId: 'org_acme',
      status: 'active',
      limit: 2,
    });

    expect(result.members).toHaveLength(2);
    expect(result.next).toBeUndefined();
  });

  it('throws forbidden when port returns denied', async () => {
    membershipPort.listOrganizationMembers.mockResolvedValue({
      kind: 'denied',
    });

    await expect(
      useCase.list({
        context,
        userId: 'usr_01J00000000000000000000001',
        organizationId: 'org_acme',
        status: 'active',
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
  });
});
