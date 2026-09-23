import {
  authorizeOrganizationMembershipMutation,
  hasOrganizationMembershipRouteAuthority,
} from './organization-membership.mutation-policy';

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

describe('hasOrganizationMembershipRouteAuthority', () => {
  // Decided before the target is looked up, so a caller without authority on
  // the route learns nothing about which usernames exist.
  it.each([
    ['change_role', 'owner', false, true],
    ['change_role', 'admin', false, true],
    ['change_role', 'member', false, false],
    ['change_role', 'member', true, false],
    ['disable', 'owner', false, true],
    ['disable', 'admin', false, true],
    ['disable', 'member', false, false],
    ['disable', 'member', true, true],
    ['transfer', 'owner', false, true],
    ['transfer', 'owner', true, true],
    ['transfer', 'admin', false, false],
    ['transfer', 'member', false, false],
  ] as const)(
    '%s by %s (acting on own membership: %s) has authority: %s',
    (action, callerRole, targetIsCaller, expected) => {
      expect(
        hasOrganizationMembershipRouteAuthority({
          action,
          callerRole,
          targetIsCaller,
        }),
      ).toBe(expected);
    },
  );
});
