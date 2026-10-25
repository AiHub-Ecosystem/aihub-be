import { AppError } from '@/common/errors/app-error';
import type { OrganizationStatus } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  ResolveMembershipInput,
} from './organization-membership.port';

export function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

/**
 * The one spelling of the rule that a suspended Organization closes an
 * Organization management surface (ADR-0044): while the Organization is
 * suspended, every Membership Role alike is refused. Each management surface
 * decides its closure through this predicate — before the act in application
 * code, or under the surface's row locks by calling it with the locked
 * status. The Organization-scoped reads answer from the admission table
 * instead, whose audit row deliberately stays open (ADR-0040).
 */
export function organizationSuspensionClosesSurface(
  status: OrganizationStatus,
): boolean {
  return status === 'suspended';
}

export async function requireActiveMembership(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  input: ResolveMembershipInput,
  forbiddenMessage = 'Organization membership is required',
): Promise<OrganizationMembershipRecord> {
  const resolution = await membership.resolveMembership(input);
  if (resolution.kind === 'active') {
    return resolution.membership;
  }

  throw new AppError({
    code: 'FORBIDDEN',
    message: forbiddenMessage,
    retryable: false,
  });
}

/**
 * Admits an active owner or admin of an active Organization. Every other
 * caller receives the same Safe Authorization Denial, so the refusal reveals
 * neither the Organization's status nor which condition refused.
 */
export async function requireOrganizationManager(
  membership: Pick<OrganizationMembershipPort, 'resolveMembership'>,
  input: ResolveMembershipInput,
  forbiddenMessage: string,
): Promise<OrganizationMembershipRecord> {
  const caller = await requireActiveMembership(
    membership,
    input,
    forbiddenMessage,
  );
  if (
    organizationSuspensionClosesSurface(caller.organizationStatus) ||
    caller.role === 'member'
  ) {
    throw forbidden(forbiddenMessage);
  }
  return caller;
}
