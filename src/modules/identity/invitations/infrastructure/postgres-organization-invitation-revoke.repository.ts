import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  auditStamp,
  recordOrganizationAuditDenial,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import type { OrganizationAuditDraft } from '@/modules/identity/domain/organization-audit-event';
import type {
  OrganizationInvitationRevocationRecordPort,
  RevokeOrganizationInvitationInput,
  RevokeOrganizationInvitationResult,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import { mayRevokeOrganizationInvitation } from '@/modules/identity/invitations/application/organization-invitation.revocation-policy';
import {
  forbidden,
  organizationSuspensionClosesSurface,
} from '@/modules/identity/membership/application/organization-membership.authorization';
import {
  dateValue,
  identityStoreUnavailable,
  invalidIdentityData,
  membershipRoleValue,
  membershipStatusValue,
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

const LOCK_ORGANIZATION_FOR_REVOKE_SQL = `
  SELECT id, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const LOCK_INVITATION_FOR_REVOKE_SQL = `
  SELECT id, organization_id, email, role, consumed_at, expires_at
  FROM organization_invitations
  WHERE id = $1
    AND organization_id = $2
  FOR UPDATE
`;

/** The caller's current Membership, read under the Organization lock. */
const LOCK_CALLER_MEMBERSHIP_FOR_REVOKE_SQL = `
  SELECT role, status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR UPDATE
`;

/** Closes an open invitation and records who closed it, or who was refused. */
export class PostgresOrganizationInvitationRevokeRepository
  implements OrganizationInvitationRevocationRecordPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async revokeInvitation(
    input: RevokeOrganizationInvitationInput,
  ): Promise<RevokeOrganizationInvitationResult> {
    if (
      input.context.userId !== input.actorUserId ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.actorUserId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      input.invitationId.trim().length === 0 ||
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime())
    ) {
      throw invalidInvitationInput();
    }

    const stamp = auditStamp(input, input.actorUserId, input.now);
    let refused: OrganizationAuditDraft | undefined;

    try {
      return await identityTransaction(this.client, async (transaction) => {
        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_FOR_REVOKE_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization)) {
          return { kind: 'not_found' };
        }

        const organizationId = stringValue(organization, 'id');
        const organizationStatus = organizationStatusValue(
          organization,
          'status',
        );
        if (
          organizationId !== input.organizationId ||
          organizationStatus === undefined
        ) {
          throw invalidIdentityData();
        }
        if (organizationSuspensionClosesSurface(organizationStatus)) {
          return { kind: 'organization_suspended' };
        }

        const invitationRows = await identityRows(
          transaction,
          LOCK_INVITATION_FOR_REVOKE_SQL,
          [input.invitationId, input.organizationId],
        );
        const invitation = invitationRows[0];
        if (!isRecord(invitation)) {
          return { kind: 'not_found' };
        }

        const invitationId = stringValue(invitation, 'id');
        const invitationOrganizationId = stringValue(
          invitation,
          'organization_id',
        );
        const email = stringValue(invitation, 'email');
        const role = membershipRoleValue(invitation, 'role');
        const expiresAt = dateValue(invitation, 'expires_at');
        const consumedAt =
          invitation.consumed_at === null
            ? null
            : dateValue(invitation, 'consumed_at');
        if (
          invitationId === undefined ||
          invitationOrganizationId !== input.organizationId ||
          email === undefined ||
          role === undefined ||
          expiresAt == null ||
          (invitation.consumed_at !== null && consumedAt === undefined)
        ) {
          throw invalidIdentityData();
        }

        // ADR-0027 as amended (#447): the caller's role is re-read under the
        // Organization lock rather than trusting the role captured before the
        // transaction, so a disable or demotion that committed while this
        // request waited cannot close an invitation it no longer has authority
        // over.
        const callerRows = await identityRows(
          transaction,
          LOCK_CALLER_MEMBERSHIP_FOR_REVOKE_SQL,
          [input.organizationId, input.actorUserId],
        );
        const callerMembership = callerRows[0];
        const callerRole = isRecord(callerMembership)
          ? membershipRoleValue(callerMembership, 'role')
          : undefined;
        const callerStatus = isRecord(callerMembership)
          ? membershipStatusValue(callerMembership, 'membership_status')
          : undefined;

        const callerAdmitted =
          callerRole !== undefined &&
          callerStatus === 'active' &&
          mayRevokeOrganizationInvitation({
            actorRole: callerRole,
            invitedRole: role,
          });

        if (!callerAdmitted) {
          // A caller who no longer actively belongs is refused without a
          // denial record; an active caller whose role lacks authority earns
          // the recorded denial, as before.
          if (callerRole !== undefined && callerStatus === 'active') {
            refused = {
              action: 'invitation.revoked',
              invitationId,
              email,
              role,
              denial: 'insufficient_authority',
            };
          }
          throw forbidden('Organization invitation revocation is forbidden');
        }

        if (consumedAt !== null || expiresAt.getTime() <= input.now.getTime()) {
          return { kind: 'closed' };
        }

        const updated = await transaction.organizationInvitation.updateMany({
          where: {
            id: input.invitationId,
            organizationId: input.organizationId,
            consumedAt: null,
            expiresAt: { gt: input.now },
          },
          data: { consumedAt: input.now },
        });
        if (updated.count === 0) {
          return { kind: 'closed' };
        }

        await recordOrganizationAuditEvent(transaction, stamp, {
          action: 'invitation.revoked',
          invitationId,
          email,
          role,
        });

        return { kind: 'closed' };
      });
    } catch (error) {
      if (refused !== undefined) {
        await recordOrganizationAuditDenial(this.client, stamp, refused);
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreUnavailable(error);
    }
  }
}
