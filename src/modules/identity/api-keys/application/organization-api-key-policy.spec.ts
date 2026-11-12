import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';
import {
  type LockedCallerAuthority,
  callerRetainsApiKeyAuthority,
  hasRequiredOrganizationApiKeyEntitlements,
  lockedCallerAuthority,
  organizationApiKeyCallerRefusal,
  reachedOrganizationApiKeyLimit,
} from './organization-api-key-policy';

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

describe('Organization API key policy', () => {
  it('requires every requested entitlement from the locked Organization row', () => {
    expect(
      hasRequiredOrganizationApiKeyEntitlements(
        ['writing', 'speaking'],
        ['writing'],
      ),
    ).toBe(true);
    expect(
      hasRequiredOrganizationApiKeyEntitlements(
        ['writing'],
        ['writing', 'speaking'],
      ),
    ).toBe(false);
  });

  it('allows no required entitlements', () => {
    expect(hasRequiredOrganizationApiKeyEntitlements([], [])).toBe(true);
  });

  it('reaches the active-key cap at equality and beyond', () => {
    expect(reachedOrganizationApiKeyLimit(9, 10)).toBe(false);
    expect(reachedOrganizationApiKeyLimit(10, 10)).toBe(true);
    expect(reachedOrganizationApiKeyLimit(11, 10)).toBe(true);
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
            callerRetainsApiKeyAuthority(
              authority,
              organizationStatus,
              surface,
            ),
          ).toBe(admitted);
        },
      );
    });

    describe('organizationApiKeyCallerRefusal', () => {
      it('reports a suspended Organization as the Organization, not the caller', async () => {
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
          organizationApiKeyCallerRefusal(
            undefined,
            'active',
            'api_key_create',
          ),
        ).toBe('caller_not_authorized');
      });
    });
  });
});
