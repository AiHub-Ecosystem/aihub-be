import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  type EmailDeliveryTransaction,
  emailDeliveryTransactionBrand,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { mayGrantInvitationRole } from '@/modules/identity/invitations/application/organization-invitation.grant-authority.policy';
import type {
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationResult,
  OrganizationInvitationCreationRecordPort,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import { organizationSuspensionClosesSurface } from '@/modules/identity/membership/application/organization-membership.authorization';
import {
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

/**
 * Locking the organization row serializes concurrent invitations for the same
 * organization, so the active-member check and the partial unique index cannot
 * be raced by two requests arriving together. The status is read under the
 * same lock so a suspension that commits first closes this surface (ADR-0027
 * as amended, #447).
 */
const LOCK_ORGANIZATION_SQL = `
  SELECT id, name, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

/** The inviter's current Membership, read under the Organization lock. */
const LOCK_INVITER_MEMBERSHIP_SQL = `
  SELECT role, status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR UPDATE
`;

function organizationName(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value, 'name') : undefined;
}

/** Sends an invitation, or resends it by superseding the open one. */
export class PostgresOrganizationInvitationCreateRepository
  implements OrganizationInvitationCreationRecordPort
{
  constructor(
    private readonly client: IdentityRepositoryClient,
    private readonly emailOutbox: EmailOutboxPort,
  ) {}

  async createInvitation(
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResult> {
    if (
      input.context.userId !== input.invitedBy ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.organizationId.trim().length === 0 ||
      input.email.trim().length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash) ||
      input.expiresAt.getTime() <= input.now.getTime()
    ) {
      throw invalidInvitationInput();
    }

    try {
      return await identityTransaction(this.client, async (transaction) => {
        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organizationRow = organizationRows[0];
        if (!isRecord(organizationRow)) throw invalidIdentityData();
        const name = organizationName(organizationRow);
        if (name === undefined) throw invalidIdentityData();

        // A suspension committed before this transaction boundary closes the
        // surface: no invitation and no email outbox request (ADR-0027 as
        // amended, #447).
        const organizationStatus = organizationStatusValue(
          organizationRow,
          'status',
        );
        if (organizationStatus === undefined) {
          throw invalidIdentityData();
        }
        if (organizationSuspensionClosesSurface(organizationStatus)) {
          return { kind: 'organization_suspended' };
        }

        // The inviter is read here, inside the transaction that commits the
        // invitation and its Email Delivery Request, so the message can name
        // who sent it (ADR-0121).
        const inviter = await transaction.userAccount.findUnique({
          where: { id: input.invitedBy },
          select: { username: true },
        });
        const inviterUsername = inviter?.username;
        if (inviterUsername === undefined) {
          throw invalidIdentityData();
        }

        // The inviter's authority is re-evaluated under the Organization lock:
        // a disable or demotion that committed while this request waited
        // refuses the send, so a pending invitation cannot outlive the
        // authority that issued it (ADR-0027 as amended, #447).
        const inviterMembershipRows = await identityRows(
          transaction,
          LOCK_INVITER_MEMBERSHIP_SQL,
          [input.organizationId, input.invitedBy],
        );
        const inviterMembership = inviterMembershipRows[0];
        const inviterRole = isRecord(inviterMembership)
          ? membershipRoleValue(inviterMembership, 'role')
          : undefined;
        const inviterStatus = isRecord(inviterMembership)
          ? membershipStatusValue(inviterMembership, 'membership_status')
          : undefined;
        if (
          inviterRole === undefined ||
          inviterStatus === undefined ||
          inviterStatus !== 'active' ||
          !mayGrantInvitationRole({
            callerRole: inviterRole,
            invitedRole: input.role,
          })
        ) {
          return { kind: 'caller_not_authorized' };
        }

        // An active member whose password identity carries this email.
        const activeMembership = await transaction.organizationMembership.count(
          {
            where: {
              organizationId: input.organizationId,
              status: 'active',
              userAccount: {
                authIdentities: {
                  some: { provider: 'password', canonicalEmail: input.email },
                },
              },
            },
          },
        );
        if (activeMembership > 0) {
          return { kind: 'member_exists' };
        }

        // Resend supersedes the previous open token, which is also what keeps
        // the one-open-invitation index satisfiable. Closing a token here is
        // also what separates a resend from a first invitation in the trail.
        const superseded = await transaction.organizationInvitation.updateMany({
          where: {
            organizationId: input.organizationId,
            email: input.email,
            consumedAt: null,
          },
          data: { consumedAt: input.now },
        });
        await transaction.organizationInvitation.create({
          data: {
            id: input.invitationId,
            organizationId: input.organizationId,
            email: input.email,
            role: input.role,
            invitedBy: input.invitedBy,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            createdAt: input.now,
          },
        });

        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(input, input.invitedBy, input.now),
          {
            action:
              superseded.count > 0 ? 'invitation.resent' : 'invitation.sent',
            invitationId: input.invitationId,
            email: input.email,
            role: input.role,
          },
        );

        // Sealed here because the Organization name is only readable in this
        // transaction, and queued here so the invitation and the request that
        // emails its credential commit or roll back together (ADR-0074).
        await this.emailOutbox.queue(
          {
            [emailDeliveryTransactionBrand]: undefined,
            client: transaction,
          } as EmailDeliveryTransaction,
          {
            kind: 'organization_invite_email',
            organizationId: input.organizationId,
            inviterId: input.invitedBy,
            payload: {
              email: input.email,
              token: input.emailDelivery.token,
              expiresAt: input.expiresAt.toISOString(),
              organizationName: name,
              role: input.role,
              inviterUsername,
            },
            createdAt: input.emailDelivery.createdAt,
          },
        );

        return { kind: 'created' };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw identityStoreUnavailable(error);
    }
  }
}
