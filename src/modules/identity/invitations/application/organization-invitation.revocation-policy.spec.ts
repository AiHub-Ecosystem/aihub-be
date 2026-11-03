import { mayRevokeOrganizationInvitation } from './organization-invitation.revocation-policy';

describe('mayRevokeOrganizationInvitation', () => {
  it.each([
    ['owner', 'owner'],
    ['owner', 'admin'],
    ['owner', 'member'],
    ['admin', 'member'],
  ] as const)('lets an %s revoke an invitation for %s', (actor, invited) => {
    expect(
      mayRevokeOrganizationInvitation({
        actorRole: actor,
        invitedRole: invited,
      }),
    ).toBe(true);
  });

  it.each([
    ['admin', 'admin'],
    ['admin', 'owner'],
    ['member', 'member'],
    ['member', 'admin'],
    ['member', 'owner'],
  ] as const)(
    'refuses an %s revoking an invitation for %s',
    (actor, invited) => {
      expect(
        mayRevokeOrganizationInvitation({
          actorRole: actor,
          invitedRole: invited,
        }),
      ).toBe(false);
    },
  );
});
