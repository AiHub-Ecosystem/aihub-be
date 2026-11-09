import { isRecord } from '@/common/is-record';
import {
  ORGANIZATION_API_KEY_ADMISSION,
  type OrganizationApiKeySurface,
} from '@/modules/identity/membership/application/organization-admission';
import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';

export function hasRequiredOrganizationApiKeyEntitlements(
  organizationEntitlements: readonly string[],
  requiredEntitlements: readonly string[],
): boolean {
  return requiredEntitlements.every((entitlement) =>
    organizationEntitlements.includes(entitlement),
  );
}

export function reachedOrganizationApiKeyLimit(
  activeKeyCount: number,
  activeKeyLimit: number,
): boolean {
  return activeKeyCount >= activeKeyLimit;
}

/**
 * ADR-0159 (decision 2): a key mutation decides the caller's authority before
 * it opens its transaction and again under the same Organization lock the
 * mutation writes through. The read before the transaction admits a caller
 * whose Membership then changes; this read is what refuses it, so a rotate
 * that serializes after a disable cannot hand out a replacement credential.
 *
 * The decision itself is the admission table's, not a second rule: an active
 * owner or admin of an active Organization. The repository supplies the locked
 * membership row and the Organization status it read under the same lock, and
 * this module owns the whole decision — including which refusal the surface
 * observes — so no repository defines the rule itself.
 */

/** The caller's Membership as the locked row reports it. */
export interface LockedCallerAuthority {
  readonly role: OrganizationMembershipRole;
  readonly status: OrganizationMembershipStatus;
}

export function lockedCallerAuthority(
  value: unknown,
): LockedCallerAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const role = value['role'];
  const status = value['membership_status'];
  return (role === 'owner' || role === 'admin' || role === 'member') &&
    (status === 'active' || status === 'disabled')
    ? { role, status }
    : undefined;
}

/**
 * Why the locked rows refuse this caller on this surface. `undefined` admits
 * the mutation. A suspended Organization is the Organization's refusal, not
 * the caller's: the surface is closed for every manager, so the mutation
 * reports `organization_unavailable` exactly as a fresh request would.
 */
export type OrganizationApiKeyCallerRefusal =
  | 'caller_not_authorized'
  | 'organization_unavailable';

export function organizationApiKeyCallerRefusal(
  authority: LockedCallerAuthority | undefined,
  organizationStatus: OrganizationStatus,
  surface: OrganizationApiKeySurface,
): OrganizationApiKeyCallerRefusal | undefined {
  const rule = ORGANIZATION_API_KEY_ADMISSION[surface];
  if (rule.suspensionClosesSurface && organizationStatus !== 'active') {
    return 'organization_unavailable';
  }
  if (authority === undefined) {
    return 'caller_not_authorized';
  }
  if (authority.status !== 'active') {
    return 'caller_not_authorized';
  }
  if (!rule.admittedRoles.includes(authority.role)) {
    return 'caller_not_authorized';
  }
  return undefined;
}

/**
 * True only when the locked rows still admit the caller to this key surface.
 * Anything else — a disabled or demoted caller, a suspended Organization, or a
 * projection that cannot be read — is a refusal.
 */
export function callerRetainsApiKeyAuthority(
  authority: LockedCallerAuthority | undefined,
  organizationStatus: OrganizationStatus,
  surface: OrganizationApiKeySurface,
): boolean {
  return (
    organizationApiKeyCallerRefusal(authority, organizationStatus, surface) ===
    undefined
  );
}
