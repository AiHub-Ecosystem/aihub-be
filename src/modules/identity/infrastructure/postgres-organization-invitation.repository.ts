import { AppError } from '@/common/errors/app-error';
import type { EmailPayloadCipher } from '@/modules/auth/application/email-delivery-request.port';
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
} from '@/modules/identity/application/organization-invitation.port';
import { forbidden } from '@/modules/identity/application/organization-membership.authorization';
import type { OrganizationAuditDraft } from '@/modules/identity/domain/organization-audit-event';

import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  organizationStatusValue,
  stringValue,
} from './identity-row';
import {
  auditStamp,
  recordOrganizationAuditDenial,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

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

const ACTIVE_MEMBERSHIP_SQL = `
  SELECT 1
  FROM organization_members AS membership
  INNER JOIN auth_identities AS identity
    ON identity.user_account_id = membership.user_account_id
  WHERE membership.organization_id = $1
    AND membership.status = 'active'
    AND identity.provider = 'password'
    AND identity.canonical_email = $2
  LIMIT 1
`;

const CLOSE_OPEN_INVITATIONS_SQL = `
  UPDATE organization_invitations
  SET consumed_at = $3
  WHERE organization_id = $1
    AND email = $2
    AND consumed_at IS NULL
  RETURNING id
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

const REVOKE_OPEN_INVITATION_SQL = `
  UPDATE organization_invitations
  SET consumed_at = $3
  WHERE id = $1
    AND organization_id = $2
    AND consumed_at IS NULL
    AND expires_at > $3
  RETURNING id
`;

const INSERT_INVITATION_SQL = `
  INSERT INTO organization_invitations (
    id, organization_id, email, role, invited_by, token_hash, expires_at, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * The outbox row an invitation commit owns. `queued` is the state the row takes
 * at commit; the worker moves it on from there (ADR-0074).
 */
const INSERT_EMAIL_DELIVERY_REQUEST_SQL = `
  INSERT INTO email_delivery_requests (id, kind, status, payload_ciphertext, created_at)
  VALUES ($1, 'organization_invite_email', 'queued', $2, $3)
`;

/**
 * The issuer is a left join on purpose: a broken identity projection must fail
 * the whole list rather than silently dropping an actionable invitation.
 * `consumed_at` is the durable close signal for consumed, superseded, and
 * revoked invitations; expiry is evaluated against the application clock.
 */
const LIST_OPEN_INVITATIONS_SQL = `
  SELECT
    invitation.id,
    invitation.email,
    invitation.role,
    inviter.username AS invited_by_username,
    invitation.created_at,
    invitation.expires_at
  FROM organization_invitations AS invitation
  LEFT JOIN user_accounts AS inviter
    ON inviter.id = invitation.invited_by
  WHERE invitation.organization_id = $1
    AND invitation.consumed_at IS NULL
    AND invitation.expires_at > $2
  ORDER BY invitation.created_at DESC, invitation.id ASC
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

const CONSUME_INVITATION_SQL = `
  UPDATE organization_invitations
  SET consumed_at = $2
  WHERE token_hash = $1
    AND consumed_at IS NULL
`;

function organizationName(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value, 'name') : undefined;
}

function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | undefined {
  const value = record[key];
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function mapOpenInvitation(
  value: unknown,
): OpenOrganizationInvitationRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const invitationId = stringValue(value, 'id');
  const email = stringValue(value, 'email');
  const role = membershipRoleValue(value, 'role');
  const invitedByUsername = stringValue(value, 'invited_by_username');
  const createdAt = dateValue(value, 'created_at');
  const expiresAt = dateValue(value, 'expires_at');

  if (
    invitationId === undefined ||
    email === undefined ||
    role === undefined ||
    invitedByUsername === undefined ||
    createdAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }

  return {
    invitationId,
    email,
    role,
    invitedByUsername,
    createdAt,
    expiresAt,
  };
}

export class PostgresOrganizationInvitationRepository
  implements OrganizationInvitationPort
{
  constructor(
    private readonly client: PostgresIdentityTransactionalClient,
    private readonly payloadCipher: EmailPayloadCipher,
  ) {}

  async createInvitation(
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResult> {
    if (
      input.context.userId !== input.invitedBy ||
      input.context.organizationId !== input.organizationId ||
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
      return await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const name = organizationName(organizationRows[0]);
        if (name === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        const activeMembership = await transaction.query(
          ACTIVE_MEMBERSHIP_SQL,
          [input.organizationId, input.email],
        );
        if (activeMembership[0] !== undefined) {
          return { kind: 'member_exists' };
        }

        // Resend supersedes the previous open token, which is also what keeps
        // the one-open-invitation index satisfiable. Closing a token here is
        // also what separates a resend from a first invitation in the trail.
        const superseded = await transaction.query(CLOSE_OPEN_INVITATIONS_SQL, [
          input.organizationId,
          input.email,
          input.now,
        ]);
        await transaction.query(INSERT_INVITATION_SQL, [
          input.invitationId,
          input.organizationId,
          input.email,
          input.role,
          input.invitedBy,
          input.tokenHash,
          input.expiresAt,
          input.now,
        ]);

        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(input, input.invitedBy, input.now),
          {
            action:
              superseded.length > 0 ? 'invitation.resent' : 'invitation.sent',
            invitationId: input.invitationId,
            email: input.email,
            role: input.role,
          },
        );

        // Sealed here because the Organization name is only readable in this
        // transaction, and queued here so the invitation and the request that
        // emails its credential commit or roll back together (ADR-0074).
        await transaction.query(INSERT_EMAIL_DELIVERY_REQUEST_SQL, [
          input.emailDelivery.id,
          this.sealInvitePayload(input, name),
          input.emailDelivery.createdAt,
        ]);

        return { kind: 'created' };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  /**
   * What the worker needs to send the message, and nothing more: the
   * credential travels only as authenticated ciphertext under a key version it
   * resolves itself from the envelope.
   */
  private sealInvitePayload(
    input: CreateOrganizationInvitationInput,
    name: string,
  ): string {
    return this.payloadCipher.encrypt(
      JSON.stringify({
        email: input.email,
        organizationName: name,
        role: input.role,
        token: input.emailDelivery.token,
        expiresAt: input.expiresAt.toISOString(),
      }),
    );
  }

  async listOpenInvitations(
    input: ListOpenOrganizationInvitationsInput,
  ): Promise<readonly OpenOrganizationInvitationRecord[]> {
    if (
      input.context.userId !== input.userId ||
      input.context.organizationId !== input.organizationId ||
      input.userId.trim().length === 0 ||
      input.organizationId.trim().length === 0 ||
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime())
    ) {
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LIST_OPEN_INVITATIONS_SQL, [
        input.organizationId,
        input.now,
      ]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    const invitations: OpenOrganizationInvitationRecord[] = [];
    for (const row of rows) {
      const invitation = mapOpenInvitation(row);
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
      input.context.organizationId !== input.organizationId ||
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
      return await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
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
        if (organizationStatus === 'suspended') {
          return { kind: 'organization_suspended' };
        }

        const invitationRows = await transaction.query(
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
          expiresAt === undefined ||
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

        const updated = await transaction.query(REVOKE_OPEN_INVITATION_SQL, [
          input.invitationId,
          input.organizationId,
          input.now,
        ]);
        if (updated.length === 0) {
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
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async acceptInvitation(
    input: AcceptOrganizationInvitationInput,
  ): Promise<AcceptOrganizationInvitationResult> {
    if (
      input.context.userId !== input.userId ||
      input.context.organizationId !== undefined ||
      !/^[0-9a-f]{64}$/.test(input.tokenHash)
    ) {
      throw identityStoreError(
        'Identity organization invitation input is invalid',
      );
    }

    try {
      return await this.client.transaction(async (transaction) => {
        const invitationRows = await transaction.query(LOCK_INVITATION_SQL, [
          input.tokenHash,
          input.now,
        ]);
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

        const accountRows = await transaction.query(ACCEPTING_ACCOUNT_SQL, [
          organizationId,
          input.userId,
        ]);
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
        if (organizationStatus === 'suspended') {
          return { kind: 'organization_suspended' };
        }

        const membershipRows = await transaction.query(UPSERT_MEMBERSHIP_SQL, [
          organizationId,
          input.userId,
          invitedRole,
          input.now,
        ]);
        const membershipRow = membershipRows[0];
        const grantedRole = isRecord(membershipRow)
          ? membershipRoleValue(membershipRow, 'role')
          : undefined;
        if (grantedRole === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        await transaction.query(CONSUME_INVITATION_SQL, [
          input.tokenHash,
          input.now,
        ]);

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
      throw identityStoreError('Identity store is unavailable');
    }
  }
}
