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

export interface OrganizationAdmissionRule {
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
  Record<OrganizationReadSurface, OrganizationAdmissionRule>
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

export type OrganizationApiKeySurface =
  | 'api_key_create'
  | 'api_key_list'
  | 'api_key_rotate'
  | 'api_key_revoke';

export interface OrganizationApiKeyAdmissionRequest
  extends ResolveMembershipInput {
  readonly surface: OrganizationApiKeySurface;
}

/**
 * The one place that states which Membership Roles may use which
 * Organization API key surface, and whether Organization Suspension closes it.
 * The authority matches the settled manager-only admission of
 * requireOrganizationManager: an active owner or admin of an active
 * Organization, every other caller refused identically.
 */
export const ORGANIZATION_API_KEY_ADMISSION: Readonly<
  Record<OrganizationApiKeySurface, OrganizationAdmissionRule>
> = {
  api_key_create: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization API key creation is forbidden',
  },
  api_key_list: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization API key access is forbidden',
  },
  api_key_rotate: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization API key rotation is forbidden',
  },
  api_key_revoke: {
    admittedRoles: OWNER_AND_ADMIN,
    suspensionClosesSurface: true,
    refusal: 'Organization API key revocation is forbidden',
  },
};

async function admit<TSurface extends string>(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  rules: Readonly<Record<TSurface, OrganizationAdmissionRule>>,
  request: ResolveMembershipInput & { readonly surface: TSurface },
): Promise<OrganizationAdmissionDecision> {
  const resolution = await membership.resolveMembership(request);

  if (resolution.kind !== 'active') {
    return { admitted: false, refusal: refusalFor(rules, request.surface) };
  }

  const caller = resolution.membership;
  const rule = rules[request.surface];

  if (!rule.admittedRoles.includes(caller.role)) {
    return { admitted: false, refusal: refusalFor(rules, request.surface) };
  }
  if (rule.suspensionClosesSurface && caller.organizationStatus !== 'active') {
    return { admitted: false, refusal: refusalFor(rules, request.surface) };
  }

  return { admitted: true, caller };
}

function refusalFor<TSurface extends string>(
  rules: Readonly<Record<TSurface, OrganizationAdmissionRule>>,
  surface: TSurface,
): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: rules[surface].refusal,
    retryable: false,
  });
}

/**
 * Resolves the caller's Membership and settles admission from the read table.
 * A durable lookup failure is left to propagate: it is an internal failure,
 * never a refusal, and never an admission.
 */
export async function admitOrganizationRead(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  request: OrganizationReadAdmissionRequest,
): Promise<OrganizationAdmissionDecision> {
  return admit(membership, ORGANIZATION_READ_ADMISSION, request);
}

/**
 * The API key surfaces settle admission through the same core the reads use.
 */
export async function admitOrganizationApiKey(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  request: OrganizationApiKeyAdmissionRequest,
): Promise<OrganizationAdmissionDecision> {
  return admit(membership, ORGANIZATION_API_KEY_ADMISSION, request);
}
