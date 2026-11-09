import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { mayGrantInvitationRole } from '@/modules/identity/invitations/application/organization-invitation.grant-authority.policy';
import type {
  AcceptOrganizationInvitationInput,
  AcceptOrganizationInvitationResult,
  OrganizationInvitationAcceptanceRecordPort,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import { organizationSuspensionClosesSurface } from '@/modules/identity/membership/application/organization-membership.authorization';
import {
  dateValue,
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
import {
  SHARE_MEMBERSHIP_AUTHORITY_SQL,
  membershipAuthority,
} from './organization-invitation-membership-authority';

/**
 * The one lookup that may run unlocked: it finds the invitation by its token
 * hash and reads only the immutable key columns, so the transaction can take
 * the Organization lock first (ADR-0107's pattern for an unlocked read of an
 * immutable key). The locked re-read below decides everything else.
 */
export const FIND_INVITATION_SQL = `
  SELECT id, organization_id
  FROM organization_invitations
  WHERE token_hash = $1
    AND consumed_at IS NULL
    AND expires_at > $2
`;

/**
 * Acceptance holds the Organization row shared from here through the grant,
 * the token consumption, and the applied event. A disable, demotion, or
 * transfer takes the same row `FOR UPDATE` before it touches any membership,
 * so it either commits before this transaction's inviter read or waits behind
 * it — the inviter's authority cannot change inside the window the grant
 * decides in (ADR-0159, decision 2). `FOR SHARE` is the weakest lock that
 * gives that serialization, and it is the same first lock every other
 * invitation and membership transaction takes.
 */
export const LOCK_ORGANIZATION_FOR_ACCEPTANCE_SQL = `
  SELECT id, status
  FROM organizations
  WHERE id = $1
  FOR SHARE
`;

/**
 * Locks the invitation row the redemption contends on: two requests redeeming
 * one token serialize here, and the loser re-reads a consumed token. The
 * re-check repeats the pre-read's conditions against the locked row, so a
 * token consumed or expired while this transaction waited for the
 * Organization lock is still refused.
 */
export const LOCK_INVITATION_SQL = `
  SELECT id, organization_id, email, role, invited_by, token_hash,
         consumed_at, expires_at
  FROM organization_invitations
  WHERE id = $1
  FOR UPDATE
`;

/**
 * The account must still be active where the membership is granted, not only at
 * the guard. A disabled account simply resolves no row here, so it lands in
 * the one generic token rejection rather than earning an outcome of its own.
 * The Organization status is not joined here: this transaction already holds
 * that row shared and reads it from the lock.
 */
export const ACCEPTING_ACCOUNT_SQL = `
  SELECT identity.canonical_email
  FROM user_accounts AS account
  LEFT JOIN auth_identities AS identity
    ON identity.user_account_id = account.id
   AND identity.provider = 'password'
  WHERE account.id = $1
    AND account.status = 'active'
`;

/**
 * One statement for create and reactivate. A disabled membership takes the
 * role the invitation named; an already-active membership keeps the role it
 * has, because accepting an invitation must never re-scope a current member.
 */
export const UPSERT_MEMBERSHIP_SQL = `
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
        const foundRows = await identityRows(transaction, FIND_INVITATION_SQL, [
          input.tokenHash,
          input.now,
        ]);
        const found = foundRows[0];
        if (!isRecord(found)) {
          return { kind: 'token_invalid' };
        }
        const foundId = stringValue(found, 'id');
        const foundOrganizationId = stringValue(found, 'organization_id');
        if (foundId === undefined || foundOrganizationId === undefined) {
          throw invalidIdentityData();
        }

        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_FOR_ACCEPTANCE_SQL,
          [foundOrganizationId],
        );
        const organizationRow = organizationRows[0];
        if (!isRecord(organizationRow)) {
          throw invalidIdentityData();
        }
        const organizationStatus = organizationStatusValue(
          organizationRow,
          'status',
        );
        if (organizationStatus === undefined) {
          throw invalidIdentityData();
        }

        const invitationRows = await identityRows(
          transaction,
          LOCK_INVITATION_SQL,
          [foundId],
        );
        const invitation = invitationRows[0];
        if (!isRecord(invitation)) {
          return { kind: 'token_invalid' };
        }

        const invitationId = stringValue(invitation, 'id');
        const organizationId = stringValue(invitation, 'organization_id');
        const invitedEmail = stringValue(invitation, 'email');
        const invitedRole = membershipRoleValue(invitation, 'role');
        const inviterId = stringValue(invitation, 'invited_by');
        if (
          invitationId === undefined ||
          organizationId === undefined ||
          invitedEmail === undefined ||
          invitedRole === undefined ||
          inviterId === undefined
        ) {
          throw invalidIdentityData();
        }

        // The token state is re-decided on the locked row: a token consumed
        // or expired while this transaction waited for the Organization lock
        // is refused here, exactly as the pre-read would have.
        const consumedAt =
          invitation.consumed_at === null
            ? null
            : dateValue(invitation, 'consumed_at');
        const expiresAt = dateValue(invitation, 'expires_at');
        if (
          stringValue(invitation, 'token_hash') !== input.tokenHash ||
          consumedAt !== null ||
          expiresAt === undefined ||
          expiresAt === null ||
          expiresAt.getTime() <= input.now.getTime()
        ) {
          return { kind: 'token_invalid' };
        }

        const accountRows = await identityRows(
          transaction,
          ACCEPTING_ACCOUNT_SQL,
          [input.userId],
        );
        const account = accountRows[0];

        // A wrong-account attempt leaves the invitation untouched, so nobody
        // can burn someone else's invitation by trying it. A missing row is a
        // disabled or unknown account: the same generic rejection.
        if (
          !isRecord(account) ||
          stringValue(account, 'canonical_email') !== invitedEmail
        ) {
          return { kind: 'token_invalid' };
        }

        // A suspension committed before this transaction's Organization lock
        // closes the surface: the token is not consumed.
        if (organizationSuspensionClosesSurface(organizationStatus)) {
          return { kind: 'organization_suspended' };
        }

        // ADR-0159 (decision 1): the invitation's authority is only as good
        // as the inviter's current Membership. An inviter who was disabled,
        // demoted, or has transferred ownership since the invitation was
        // issued can no longer grant the named role, so acceptance refuses
        // here — under the same Organization lock the grant commits through —
        // rather than letting a stale grant through. The refusal is the
        // generic token rejection, so it reveals nothing about the
        // Organization's members.
        const inviterRows = await identityRows(
          transaction,
          SHARE_MEMBERSHIP_AUTHORITY_SQL,
          [organizationId, inviterId],
        );
        const inviter = membershipAuthority(inviterRows[0]);
        if (
          inviter === undefined ||
          inviter.status !== 'active' ||
          !mayGrantInvitationRole({
            callerRole: inviter.role,
            invitedRole,
          })
        ) {
          return { kind: 'inviter_unauthorized' };
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
