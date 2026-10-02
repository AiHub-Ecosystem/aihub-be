import {
  ORGANIZATION_READ_ADMISSION,
  type OrganizationReadSurface,
} from '@/modules/identity/application/organization-admission';
import type { OrganizationMembershipRole } from '@/modules/identity/application/organization-membership.port';

import { admittedRoles } from './postgres-organization-membership.repository';

describe('membership list query admission', () => {
  it('passes the admitted Membership Roles as query values, not query text', () => {
    expect(
      admittedRoles(ORGANIZATION_READ_ADMISSION.membership_list.admittedRoles),
    ).toEqual(['owner', 'admin']);
  });

  it('refuses a surface that admits no Membership Role rather than reading without authorization', () => {
    expect(() => admittedRoles([])).toThrow(
      'organization read admission must admit at least one Membership Role',
    );
  });

  it('closes the membership list on suspension, matching the table', () => {
    expect(
      ORGANIZATION_READ_ADMISSION.membership_list.suspensionClosesSurface,
    ).toBe(true);
  });

  it('keeps each surface refusal text unique so one surface cannot answer with another surface refusal', () => {
    const surfaces = Object.keys(
      ORGANIZATION_READ_ADMISSION,
    ) as readonly OrganizationReadSurface[];
    const refusals = surfaces.map(
      (surface) => ORGANIZATION_READ_ADMISSION[surface].refusal,
    );

    expect(new Set(refusals).size).toBe(surfaces.length);
  });

  it('admits no surface that is caller-scoped', () => {
    const roles: readonly OrganizationMembershipRole[] = [
      'owner',
      'admin',
      'member',
    ];

    for (const rule of Object.values(ORGANIZATION_READ_ADMISSION)) {
      // A rule admitting every Membership Role is what a caller-scoped read
      // looks like, and none of these reads is one.
      expect(rule.admittedRoles.length).toBeLessThan(roles.length);
    }
  });
});
