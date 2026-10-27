import { recordRejected } from '@/common/observability/rejected-metric';
import { invalidUserIdentity } from '@/modules/identity/user-assertions/application/user-identity-errors';
import type {
  ResolvedUserIdentity,
  UserIdentityResolverPort,
} from '@/modules/identity/user-assertions/application/user-identity-resolver.port';

/**
 * The one chain every guard runs on a present `X-User-Identity` header:
 * a non-blank string, resolved against the caller's Organization, and an
 * answer that still names that Organization. Absence is each guard's own
 * decision, since only some routes have a local bypass.
 */
export async function resolveUserIdentity(
  header: unknown,
  organizationId: string,
  resolver: UserIdentityResolverPort,
): Promise<ResolvedUserIdentity> {
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw invalidUserIdentity();
  }

  const identity = await resolver.resolve({ value: header, organizationId });
  if (identity.organizationId !== organizationId) {
    recordRejected('auth');
    throw invalidUserIdentity();
  }
  return identity;
}
