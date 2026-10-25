import { AppError } from '@/common/errors/app-error';
import type { EmailDeliveryTransaction } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { emailDeliveryTransactionBrand } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type {
  EmailDeliveryRequestWriterPort,
  EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { OrganizationAuditDraft } from '@/modules/identity/domain/organization-audit-event';
import type {
  AcceptOrganizationInvitationInput,
  AcceptOrganizationInvitationResult,
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationResult,
  ListOpenOrganizationInvitationsInput,
  OpenOrganizationInvitationRecord,
  OrganizationInvitationPort,
  RevokeOrganizationInvitationInput,
  RevokeOrganizationInvitationResult,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import {
  forbidden,
  organizationSuspensionClosesSurface,
} from '@/modules/identity/membership/application/organization-membership.authorization';

import {
  auditStamp,
  recordOrganizationAuditDenial,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import {
  dateValue,
  identityStoreError,
  identityStoreUnavailable,
  isRecord,
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
import { mapOpenOrganizationInvitation } from './map-open-organization-invitation';
import { sealOrganizationInvitationEmailPayload } from './seal-organization-invitation-email-payload';

/**
 * Locking the organization row serializes concurrent invitations for the same
 * organization, so the active-member check and the partial unique index cannot
 * be raced by two requests arriving together.
 */
const LOCK_ORGANIZATION_SQL = `
  SELECT id, name
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

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

function organizationName(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value, 'name') : undefined;
}

export class PostgresOrganizationInvitationRepository
  implements OrganizationInvitationPort
{
  constructor(
    private readonly client: IdentityRepositoryClient,
    private readonly payloadCipher: EmailPayloadCipherPort,
    private readonly emailRequests: EmailDeliveryRequestWriterPort,
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
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
    }

    try {
      return await identityTransaction(this.client, async (transaction) => {
        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const name = organizationName(organizationRows[0]);
        if (name === undefined) {
          throw identityStoreError('Identity data is invalid');
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
          throw identityStoreError('Identity data is invalid');
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
        await this.emailRequests.insert(
          {
            [emailDeliveryTransactionBrand]: undefined,
            client: transaction,
          } as EmailDeliveryTransaction,
          {
            id: input.emailDelivery.id,
            kind: 'organization_invite_email',
            organizationId: input.organizationId,
            inviterId: input.invitedBy,
            payloadCiphertext: sealOrganizationInvitationEmailPayload(
              this.payloadCipher,
              input,
              name,
              inviterUsername,
            ),
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

  async listOpenInvitations(
    input: ListOpenOrganizationInvitationsInput,
  ): Promise<readonly OpenOrganizationInvitationRecord[]> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime())
    ) {
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
    }

    // The issuer is read through the relation, so a broken identity projection
    // fails the whole list rather than silently dropping an actionable
    // invitation. `consumedAt` is the durable close signal for consumed,
    // superseded, and revoked invitations; expiry is evaluated against the
    // application clock.
    let rows: readonly unknown[];
    try {
      const open = await this.client.organizationInvitation.findMany({
        where: {
          organizationId: input.organizationId,
          consumedAt: null,
          expiresAt: { gt: input.now },
        },
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          expiresAt: true,
          invitedByUser: { select: { username: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      rows = open.map(({ invitedByUser, ...invitation }) => ({
        ...invitation,
        invitedByUsername: invitedByUser.username,
      }));
    } catch (error) {
      throw identityStoreUnavailable(error);
    }

    const invitations: OpenOrganizationInvitationRecord[] = [];
    for (const row of rows) {
      const invitation = mapOpenOrganizationInvitation(row);
      if (invitation === undefined) {
        throw identityStoreError('Identity data is invalid');
      }
      invitations.push(invitation);
    }

    return invitations;
  }

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
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
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
          throw identityStoreError('Identity data is invalid');
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
          throw identityStoreError('Identity data is invalid');
        }

        if (
          input.actorRole === 'member' ||
          (input.actorRole === 'admin' && role !== 'member')
        ) {
          refused = {
            action: 'invitation.revoked',
            invitationId,
            email,
            role,
            denial: 'insufficient_authority',
          };
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

  async acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<AcceptOrganizationInvitationResult> {
    if (
      input.context.userId !== input.userId ||
      !isOrganizationContextAllowed(input.context, { kind: 'forbidden' }) ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash)
    ) {
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
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
          throw identityStoreError('Identity data is invalid');
        }

        const accountRows = await identityRows(
          transaction,
          ACCEPTING_ACCOUNT_SQL,
          [organizationId, input.userId],
        );
        const account = accountRows[0];
        if (!isRecord(account)) {
          throw identityStoreError('Identity data is invalid');
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
          throw identityStoreError('Identity data is invalid');
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
          throw identityStoreError('Identity data is invalid');
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
