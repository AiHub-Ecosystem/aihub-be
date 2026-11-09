import {
  type LockedCallerAuthority,
  type OrganizationApiKeyCallerRefusal,
  lockedCallerAuthority,
  organizationApiKeyCallerRefusal,
} from '@/modules/identity/api-keys/application/organization-api-key-policy';
import type { OrganizationApiKeySurface } from '@/modules/identity/membership/application/organization-admission';
import type { OrganizationStatus } from '@/modules/identity/organizations/application/organization-status.port';
import { identityRows } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

/**
 * The caller's Membership, read inside the mutation's transaction. The
 * Organization row is already locked by the mutation's own first statement —
 * the same first lock every disable, demotion, invitation, and key mutation
 * takes (ADR-0159, decision 6) — so this read sees the Membership an
 * authority change that committed earlier left behind, and one that starts
 * later waits behind the mutation.
 */
export const LOCK_CALLER_MEMBERSHIP_SQL = `
  SELECT
    membership.role,
    membership.status AS membership_status
  FROM organization_members AS membership
  WHERE membership.organization_id = $1
    AND membership.user_account_id = $2
`;

type IdentitySqlClient = Parameters<typeof identityRows>[0];

/**
 * Reads the caller's Membership under the Organization lock the mutation
 * already holds and evaluates the application policy against the
 * Organization status that same transaction read from the locked row. The
 * refusal — if any — is the policy's; this adapter only supplies the rows.
 * A missing Membership and a disabled one are the same refusal.
 */
export async function organizationApiKeyCallerRefusalFor(
  transaction: IdentitySqlClient,
  organizationId: string,
  actorUserId: string,
  surface: OrganizationApiKeySurface,
  organizationStatus: OrganizationStatus,
): Promise<OrganizationApiKeyCallerRefusal | undefined> {
  const rows = await identityRows(transaction, LOCK_CALLER_MEMBERSHIP_SQL, [
    organizationId,
    actorUserId,
  ]);
  const authority: LockedCallerAuthority | undefined = lockedCallerAuthority(
    rows[0],
  );
  return organizationApiKeyCallerRefusal(
    authority,
    organizationStatus,
    surface,
  );
}
