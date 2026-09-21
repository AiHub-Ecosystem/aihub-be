import { AppError } from '../../../common/errors/app-error';
import type {
  OrganizationMembershipPort,
  OrganizationMembershipRecord,
  ResolveMembershipInput,
} from './organization-membership.port';

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
