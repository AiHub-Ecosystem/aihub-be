import { createRequestContext } from '../../../common/request-context/request-context.factory';

import {
  ORGANIZATION_READ_ADMISSION,
  type OrganizationAdmissionDecision,
  type OrganizationReadSurface,
  admitOrganizationRead,
  decideOrganizationRead,
} from './organization-admission';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipResolution,
  OrganizationMembershipRole,
} from './organization-membership.port';

function refusalOf(
  decision: OrganizationAdmissionDecision,
): string | undefined {
  return decision.admitted ? undefined : decision.refusal.message;
}

function codeOf(decision: OrganizationAdmissionDecision): string | undefined {
  return decision.admitted ? undefined : decision.refusal.code;
}

type OrganizationStatus = 'active' | 'suspended';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-21T12:00:00.000Z'),
  deadlineMs: 5_000,
  organizationId: ORGANIZATION_ID,
  userId: USER_ID,
  scopes: [],
});

function record(
  role: OrganizationMembershipRole,
  organizationStatus: OrganizationStatus = 'active',
): OrganizationMembershipRecord {
  return {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    organizationStatus,
    role,
    status: 'active',
  };
}

function portReturning(
  resolution: OrganizationMembershipResolution,
): Pick<OrganizationMembershipPort, 'resolveMembership'> {
  return { resolveMembership: async () => resolution };
}

const SURFACES: readonly OrganizationReadSurface[] = [
  'membership_list',
  'open_invitations',
  'audit_read',
  'identity_configuration',
];

describe('ORGANIZATION_READ_ADMISSION', () => {
  it('states a refusal for every Organization-scoped read', () => {
    for (const surface of SURFACES) {
      expect(
        ORGANIZATION_READ_ADMISSION[surface].refusal.length,
      ).toBeGreaterThan(0);
    }
  });

  it('gives every read at least one Membership Role, so no row can admit everyone by accident', () => {
    for (const surface of SURFACES) {
      expect(
        ORGANIZATION_READ_ADMISSION[surface].admittedRoles.length,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the caller-scoped roster out of the table', () => {
    expect(Object.keys(ORGANIZATION_READ_ADMISSION)).not.toContain('roster');
  });
});

describe('decideOrganizationRead', () => {
  // Expected outcomes are written here by hand, not read back from the table,
  // so a corrupted table still fails the build.
  const EXPECTED: Readonly<
    Record<
      OrganizationReadSurface,
      Readonly<
        Record<
          string,
          { readonly admitted: boolean; readonly suspended: boolean }
        >
      >
    >
  > = {
    membership_list: {
      owner: { admitted: true, suspended: false },
      admin: { admitted: true, suspended: false },
      member: { admitted: false, suspended: false },
    },
    open_invitations: {
      owner: { admitted: true, suspended: false },
      admin: { admitted: true, suspended: false },
      member: { admitted: false, suspended: false },
    },
    audit_read: {
      owner: { admitted: true, suspended: true },
      admin: { admitted: true, suspended: true },
      // A member is refused on role, so suspension cannot admit it either.
      member: { admitted: false, suspended: false },
    },
    identity_configuration: {
      owner: { admitted: true, suspended: false },
      admin: { admitted: false, suspended: false },
      member: { admitted: false, suspended: false },
    },
  };

  /**
   * Looks up a hand-written expectation and fails loudly when a surface/role
   * pair has none, so widening the table cannot silently understate a case.
   */
  function expectedFor(
    surface: OrganizationReadSurface,
    role: OrganizationMembershipRole,
  ): { readonly admitted: boolean; readonly suspended: boolean } {
    const row = EXPECTED[surface][role];
    if (row === undefined) {
      throw new Error(`no hand-written expectation for ${surface} / ${role}`);
    }
    return row;
  }

  it.each(
    SURFACES.flatMap((surface) =>
      (['owner', 'admin', 'member'] as const).flatMap((role) => [
        [
          `${surface} admits or refuses an ${role} of an active Organization`,
          surface,
          role,
          'active' as const,
          expectedFor(surface, role).admitted,
        ] as const,
        [
          `${surface} admits or refuses an ${role} of a suspended Organization`,
          surface,
          role,
          'suspended' as const,
          expectedFor(surface, role).suspended,
        ] as const,
      ]),
    ),
  )('%s', (_label, surface, role, organizationStatus, admitted) => {
    const decision = decideOrganizationRead(
      surface,
      record(role, organizationStatus),
    );

    expect(decision.admitted).toBe(admitted);
    expect(refusalOf(decision)).toBe(
      admitted ? undefined : ORGANIZATION_READ_ADMISSION[surface].refusal,
    );
    expect(codeOf(decision)).toBe(admitted ? undefined : 'FORBIDDEN');
  });

  it('refuses with the surface refusal text, never another surface text', () => {
    const refusals = new Set(
      SURFACES.map((surface) => ORGANIZATION_READ_ADMISSION[surface].refusal),
    );

    expect(refusals.size).toBe(SURFACES.length);
  });

  it('carries the caller record through an admission so a use case can use it', () => {
    const caller = record('owner');

    const decision = decideOrganizationRead('open_invitations', caller);

    expect(decision).toEqual({ admitted: true, caller });
  });
});

describe('admitOrganizationRead', () => {
  async function admit(
    resolution: OrganizationMembershipResolution,
    surface: OrganizationReadSurface = 'open_invitations',
  ): Promise<OrganizationAdmissionDecision> {
    return admitOrganizationRead(portReturning(resolution), {
      surface,
      context,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
  }

  it('admits an active owner of an active Organization', async () => {
    const decision = await admit({
      kind: 'active',
      membership: record('owner'),
    });

    expect(decision.admitted).toBe(true);
  });

  it('refuses a caller with no membership in the Organization', async () => {
    const decision = await admit({ kind: 'missing' });

    expect(decision.admitted).toBe(false);
    expect(refusalOf(decision)).toBe(
      ORGANIZATION_READ_ADMISSION.open_invitations.refusal,
    );
  });

  it('refuses a disabled membership', async () => {
    const decision = await admit({
      kind: 'disabled',
      membership: { ...record('owner'), status: 'disabled' },
    });

    expect(decision.admitted).toBe(false);
  });

  it('leaves a durable lookup failure as an internal failure, never a refusal and never an admission', async () => {
    const failure = new Error('Identity store is unavailable');

    await expect(
      admitOrganizationRead(
        {
          resolveMembership: async () => {
            throw failure;
          },
        },
        {
          surface: 'open_invitations',
          context,
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
        },
      ),
    ).rejects.toBe(failure);
  });

  it('settles the membership list from the same table as the application-tier reads', async () => {
    const decision = await admit(
      { kind: 'active', membership: record('admin') },
      'membership_list',
    );

    expect(decision.admitted).toBe(true);
  });
});
