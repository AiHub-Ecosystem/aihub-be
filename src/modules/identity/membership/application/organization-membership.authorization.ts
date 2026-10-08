import { AppError } from '@/common/errors/app-error';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  ResolveMembershipInput,
} from './organization-membership.port';

export function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
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
  if (caller.organizationStatus === 'suspended' || caller.role === 'member') {
    throw forbidden(forbiddenMessage);
  }
  return caller;
}
