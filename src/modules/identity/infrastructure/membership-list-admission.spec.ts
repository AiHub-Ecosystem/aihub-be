import {
  ORGANIZATION_READ_ADMISSION,
  type OrganizationReadSurface,
} from '../application/organization-admission';
import type { OrganizationMembershipRole } from '../application/organization-membership.port';

import { renderAdmittedRoles } from './postgres-organization-membership.repository';

describe('membership list query admission', () => {
  it('renders the admitted Membership Roles as a SQL list', () => {
    expect(renderAdmittedRoles(['owner', 'admin'])).toBe("'owner', 'admin'");
  });

  it('refuses an empty role set instead of rendering a query that admits everyone', () => {
    expect(() => renderAdmittedRoles([])).toThrow(
      'organization read admission must admit at least one Membership Role',
    );
  });

  it('never renders an empty IN list for any surface the table declares', () => {
    for (const rule of Object.values(ORGANIZATION_READ_ADMISSION)) {
      expect(renderAdmittedRoles(rule.admittedRoles)).not.toBe('');
    }
  });

  it('takes the membership list roles from the shared table, not a private copy', () => {
    const rule = ORGANIZATION_READ_ADMISSION.membership_list;

    expect(renderAdmittedRoles(rule.admittedRoles)).toBe(
      renderAdmittedRoles(['owner', 'admin']),
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
