import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import type {
  AcceptOrganizationInvitationInput,
  AcceptOrganizationInvitationResult,
  OrganizationInvitationAcceptanceRecordPort,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import { organizationSuspensionClosesSurface } from '@/modules/identity/membership/application/organization-membership.authorization';
import {
  identityStoreUnavailable,
  invalidIdentityData,
  membershipRoleValue,
  organizationStatusValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { isOrganizationContextAllowed } from '@/modules/identity/shared/infrastructure/organization-context-policy';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { invalidInvitationInput } from './organization-invitation-input';

/**
 * Locks the invitation, not the organization: the real contention is two
 * requests redeeming one token, and this is the row both of them find.
 */
const LOCK_INVITATION_SQL = `
  SELECT id, organization_id, email, role
  FROM organization_invitations
  WHERE token_hash = $1
    AND consumed_at IS NULL
    AND expires_at > $2
  FOR UPDATE
`;

/**
 * The account must still be active where the membership is granted, not only at
 * the guard. A disabled account simply resolves no email here, so it lands in
 * the one generic token rejection rather than earning an outcome of its own.
 */
const ACCEPTING_ACCOUNT_SQL = `
  SELECT organization.status AS organization_status,
         identity.canonical_email
  FROM organizations AS organization
  LEFT JOIN user_accounts AS account
    ON account.id = $2
   AND account.status = 'active'
  LEFT JOIN auth_identities AS identity
    ON identity.user_account_id = account.id
   AND identity.provider = 'password'
  WHERE organization.id = $1
`;

/**
 * One statement for create and reactivate. A disabled membership takes the
 * role the invitation named; an already-active membership keeps the role it
 * has, because accepting an invitation must never re-scope a current member.
 */
const UPSERT_MEMBERSHIP_SQL = `
  INSERT INTO organization_members (
    organization_id, user_account_id, role, status, created_at, updated_at
  ) VALUES ($1, $2, $3, 'active', $4, $4)
  ON CONFLICT (organization_id, user_account_id) DO UPDATE
  SET status = 'active',
      role = CASE
               WHEN organization_members.status = 'disabled'
               THEN EXCLUDED.role
               ELSE organization_members.role
             END
  RETURNING role
`;

/** Redeems an invitation token into a membership. */
export class PostgresOrganizationInvitationAcceptRepository
  implements OrganizationInvitationAcceptanceRecordPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<AcceptOrganizationInvitationResult> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, { kind: 'forbidden' }) ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash)
    ) {
      throw invalidInvitationInput();
    }

    try {
      return await identityTransaction(this.client, async (transaction) => {
        const invitationRows = await identityRows(
          transaction,
          LOCK_INVITATION_SQL,
          [input.tokenHash, input.now],
        );
        const invitation = invitationRows[0];
        if (!isRecord(invitation)) {
          return { kind: 'token_invalid' };
        }

        const invitationId = stringValue(invitation, 'id');
        const organizationId = stringValue(invitation, 'organization_id');
        const invitedEmail = stringValue(invitation, 'email');
        const invitedRole = membershipRoleValue(invitation, 'role');
        if (
          invitationId === undefined ||
          organizationId === undefined ||
          invitedEmail === undefined ||
          invitedRole === undefined
        ) {
          throw invalidIdentityData();
        }

        const accountRows = await identityRows(
          transaction,
          ACCEPTING_ACCOUNT_SQL,
          [organizationId, input.userId],
        );
        const account = accountRows[0];
        if (!isRecord(account)) {
          throw invalidIdentityData();
        }

        // A wrong-account attempt leaves the invitation untouched, so nobody
        // can burn someone else's invitation by trying it.
        if (stringValue(account, 'canonical_email') !== invitedEmail) {
          return { kind: 'token_invalid' };
        }

        const organizationStatus = organizationStatusValue(
          account,
          'organization_status',
        );
        if (organizationStatus === undefined) {
          throw invalidIdentityData();
        }
        if (organizationSuspensionClosesSurface(organizationStatus)) {
          return { kind: 'organization_suspended' };
        }

        const membershipRows = await identityRows(
          transaction,
          UPSERT_MEMBERSHIP_SQL,
          [organizationId, input.userId, invitedRole, input.now],
        );
        const membershipRow = membershipRows[0];
        const grantedRole = isRecord(membershipRow)
          ? membershipRoleValue(membershipRow, 'role')
          : undefined;
        if (grantedRole === undefined) {
          throw invalidIdentityData();
        }

        await transaction.organizationInvitation.updateMany({
          where: { tokenHash: input.tokenHash, consumedAt: null },
          data: { consumedAt: input.now },
        });

        // The granted role, not the invited one: an already-active membership
        // keeps the authority it has, and the trail must say what was granted.
        await recordOrganizationAuditEvent(
          transaction,
          auditStamp({ ...input, organizationId }, input.userId, input.now),
          {
            action: 'invitation.accepted',
            invitationId,
            email: invitedEmail,
            role: grantedRole,
          },
        );

        return { kind: 'accepted', organizationId, role: grantedRole };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreUnavailable(error);
    }
  }
}
