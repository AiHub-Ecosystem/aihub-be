import { authorizeOrganizationMembershipMutation } from './organization-membership.mutation-policy';

const base = {
  callerUserId: 'usr_caller',
  callerRole: 'owner' as const,
  targetUserId: 'usr_target',
  targetRole: 'member' as const,
  targetStatus: 'active' as const,
};

describe('authorizeOrganizationMembershipMutation', () => {
  it('lets an owner demote another owner when the transaction preserves an owner', () => {
    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        targetRole: 'owner',
        action: 'change_role',
        requestedRole: 'admin',
      }),
    ).toEqual({ kind: 'allowed' });
  });

  it('lets an admin change only an active member role', () => {
    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        callerRole: 'admin',
        action: 'change_role',
        requestedRole: 'admin',
      }),
    ).toEqual({ kind: 'allowed' });

    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        callerRole: 'admin',
        targetRole: 'admin',
        action: 'change_role',
        requestedRole: 'member',
      }),
    ).toEqual({ kind: 'forbidden' });
  });

  it('allows every role to disable itself', () => {
    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        callerRole: 'member',
        callerUserId: 'usr_target',
        action: 'disable',
      }),
    ).toEqual({ kind: 'allowed' });
  });

  it('rejects self role changes for a member and self transfer for an owner', () => {
    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        callerRole: 'member',
        callerUserId: 'usr_target',
        action: 'change_role',
        requestedRole: 'admin',
      }),
    ).toEqual({ kind: 'forbidden' });

    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        callerUserId: 'usr_target',
        targetUserId: 'usr_target',
        action: 'transfer',
      }),
    ).toEqual({ kind: 'forbidden' });
  });

  it('requires active targets for role changes and transfers', () => {
    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        targetStatus: 'disabled',
        action: 'change_role',
        requestedRole: 'admin',
      }),
    ).toEqual({ kind: 'target_unavailable' });

    expect(
      authorizeOrganizationMembershipMutation({
        ...base,
        targetStatus: 'disabled',
        action: 'transfer',
      }),
    ).toEqual({ kind: 'target_unavailable' });
  });
});
