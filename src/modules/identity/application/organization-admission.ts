import { AppError } from '@/common/errors/app-error';

import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipRole,
  ResolveMembershipInput,
} from './organization-membership.port';

/**
 * The Organization-scoped reads that settle admission before returning
 * anything. The caller-scoped Organization Roster is absent on purpose: it has
 * no Organization to be refused from, admits every Membership Role, and keeps a
 * suspended Organization visible.
 */
export type OrganizationReadSurface =
  | 'membership_list'
  | 'open_invitations'
  | 'audit_read'
  | 'identity_configuration';

export interface OrganizationReadAdmissionRule {
  readonly admittedRoles: readonly OrganizationMembershipRole[];
  /** False only where a suspended Organization stays readable. */
  readonly suspensionClosesSurface: boolean;
  readonly refusal: string;
}

const OWNER_AND_ADMIN = ['owner', 'admin'] as const;
const OWNER_ONLY = ['owner'] as const;

/**
 * The one place that states which Membership Roles may read which
 * Organization-scoped surface, and whether Organization Suspension closes it.
 */
export const ORGANIZATION_READ_ADMISSION: Readonly<
  Record<OrganizationReadSurface, OrganizationReadAdmissionRule>
> = {
  membership_list: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization membership list access is forbidden',
  },
  open_invitations: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization invitation access is forbidden',
  },
  // ADR-0040: refusing this read would erase the record exactly when a
  // suspended Organization's owner is the one who needs it. The divergence is
  // a row with the flag false so it reads as a decision, not an omission.
  audit_read: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: false,
    refusal: 'Organization audit access is forbidden',
  },
  // ADR-0055: the issuer and JWKS speak for the whole Organization, so the
  // Membership Role that may replace them is the one that may read them.
  identity_configuration: {
    admittedRoles: OWNER_ONLY,
    suspensionClosesSurface: true,
    refusal: 'Organization identity configuration access is forbidden',
  },
};

export type OrganizationAdmissionDecision =
  | {
      readonly admitted: true;
      readonly caller: OrganizationMembershipRecord;
    }
  | {
      readonly admitted: false;
      readonly refusal: AppError;
    };

export interface OrganizationReadAdmissionRequest
  extends ResolveMembershipInput {
  readonly surface: OrganizationReadSurface;
}

/**
 * A surface's single refusal, for every caller outside its authority. Owned
 * here rather than borrowed from the membership mutation helpers, which are
 * being retired: an admitted caller and a refused caller must not be able to
 * tell those two apart from how the refusal was built.
 */
function refuse(surface: OrganizationReadSurface): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: ORGANIZATION_READ_ADMISSION[surface].refusal,
    retryable: false,
  });
}

/**
 * Resolves the caller's Membership and settles admission from the table above.
 * A durable lookup failure is left to propagate: it is an internal failure,
 * never a refusal, and never an admission.
 */
export async function admitOrganizationRead(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  request: OrganizationReadAdmissionRequest,
): Promise<OrganizationAdmissionDecision> {
  const resolution = await membership.resolveMembership(request);

  if (resolution.kind !== 'active') {
    return { admitted: false, refusal: refuse(request.surface) };
  }

  const caller = resolution.membership;
  const rule = ORGANIZATION_READ_ADMISSION[request.surface];

  if (!rule.admittedRoles.includes(caller.role)) {
    return { admitted: false, refusal: refuse(request.surface) };
  }
  if (rule.suspensionClosesSurface && caller.organizationStatus !== 'active') {
    return { admitted: false, refusal: refuse(request.surface) };
  }

  return { admitted: true, caller };
}
