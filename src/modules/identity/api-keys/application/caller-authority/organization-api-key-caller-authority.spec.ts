import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';
import {
  type LockedCallerAuthority,
  callerRetainsApiKeyAuthority,
  lockedCallerAuthority,
  organizationApiKeyCallerRefusal,
} from './organization-api-key-caller-authority';

const OWNER = lockedCallerAuthority({
  role: 'owner',
  membership_status: 'active',
});
const ADMIN = lockedCallerAuthority({
  role: 'admin',
  membership_status: 'active',
});
const MEMBER = lockedCallerAuthority({
  role: 'member',
  membership_status: 'active',
});
const DISABLED_OWNER = lockedCallerAuthority({
  role: 'owner',
  membership_status: 'disabled',
});

describe('the locked caller authority of an Organization API key surface', () => {
  describe('lockedCallerAuthority', () => {
    it('reads the role and status the locked membership row reports', () => {
      expect(
        lockedCallerAuthority({ role: 'owner', membership_status: 'active' }),
      ).toEqual({ role: 'owner', status: 'active' });
      expect(
        lockedCallerAuthority({
          role: 'member',
          membership_status: 'disabled',
        }),
      ).toEqual({ role: 'member', status: 'disabled' });
    });

    it.each([
      [undefined],
      ['owner'],
      [{ role: 'guest', membership_status: 'active' }],
      [{ role: 'owner', membership_status: 'revoked' }],
      [{ role: 'owner' }],
      [{ membership_status: 'active' }],
    ])('refuses a row it cannot read: %j', (row) => {
      expect(lockedCallerAuthority(row)).toBeUndefined();
    });
  });

  describe('callerRetainsApiKeyAuthority', () => {
    it.each([
      ['api_key_create', OWNER, 'active', true],
      ['api_key_revoke', ADMIN, 'active', true],
      ['api_key_rotate', ADMIN, 'active', true],
      ['api_key_create', MEMBER, 'active', false],
      ['api_key_rotate', DISABLED_OWNER, 'active', false],
      ['api_key_revoke', undefined, 'active', false],
      ['api_key_create', OWNER, 'suspended', false],
      ['api_key_list', ADMIN, 'suspended', false],
    ] as readonly [
      Parameters<typeof callerRetainsApiKeyAuthority>[2],
      LockedCallerAuthority | undefined,
      OrganizationStatus,
      boolean,
    ][])(
      '%s with %j membership on a %s Organization: %j',
      (surface, authority, organizationStatus, admitted) => {
        expect(
          callerRetainsApiKeyAuthority(authority, organizationStatus, surface),
        ).toBe(admitted);
      },
    );
  });

  describe('organizationApiKeyCallerRefusal', () => {
    it('reports a suspended Organization as the Organization, not the caller', async () => {
      // The surface is closed for every manager, so the refusal the mutation
      // reports is the Organization's — the same outcome a fresh request
      // receives — even when the locked caller is an active owner.
      expect(
        organizationApiKeyCallerRefusal(OWNER, 'suspended', 'api_key_create'),
      ).toBe('organization_unavailable');
    });

    it('reports a demoted or disabled caller as the caller', () => {
      expect(
        organizationApiKeyCallerRefusal(MEMBER, 'active', 'api_key_rotate'),
      ).toBe('caller_not_authorized');
      expect(
        organizationApiKeyCallerRefusal(
          DISABLED_OWNER,
          'active',
          'api_key_revoke',
        ),
      ).toBe('caller_not_authorized');
      expect(
        organizationApiKeyCallerRefusal(undefined, 'active', 'api_key_create'),
      ).toBe('caller_not_authorized');
    });
  });
});
