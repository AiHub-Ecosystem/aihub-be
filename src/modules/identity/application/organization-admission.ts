import type { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';

import { forbidden } from './organization-membership.authorization';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  OrganizationMembershipRole,
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

export interface OrganizationReadAdmissionRequest {
  readonly surface: OrganizationReadSurface;
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * Settles admission for a caller whose Membership record is already in hand.
 * Pure, so a caller inside a transaction can use it without the module knowing
 * that transactions exist.
 */
export function decideOrganizationRead(
  surface: OrganizationReadSurface,
  caller: OrganizationMembershipRecord,
): OrganizationAdmissionDecision {
  const rule = ORGANIZATION_READ_ADMISSION[surface];

  if (!rule.admittedRoles.includes(caller.role)) {
    return { admitted: false, refusal: forbidden(rule.refusal) };
  }
  if (rule.suspensionClosesSurface && caller.organizationStatus !== 'active') {
    return { admitted: false, refusal: forbidden(rule.refusal) };
  }

  return { admitted: true, caller };
}

/**
 * Resolves the caller's Membership and settles admission from the same table.
 * A durable lookup failure is left to propagate: it is an internal failure,
 * never a refusal, and never an admission.
 */
export async function admitOrganizationRead(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  request: OrganizationReadAdmissionRequest,
): Promise<OrganizationAdmissionDecision> {
  const resolution = await membership.resolveMembership({
    context: request.context,
    userId: request.userId,
    organizationId: request.organizationId,
  });

  if (resolution.kind !== 'active') {
    return {
      admitted: false,
      refusal: forbidden(ORGANIZATION_READ_ADMISSION[request.surface].refusal),
    };
  }

  return decideOrganizationRead(request.surface, resolution.membership);
}
