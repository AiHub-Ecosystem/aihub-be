import { AppError } from '../../../common/errors/app-error';
import type {
  AcceptOrganizationInvitationInput,
  AcceptOrganizationInvitationResult,
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationResult,
  OrganizationInvitationPort,
} from '../application/organization-invitation.port';

import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  organizationStatusValue,
  stringValue,
} from './identity-row';
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
`;

const INSERT_INVITATION_SQL = `
  INSERT INTO organization_invitations (
    id, organization_id, email, role, invited_by, token_hash, expires_at, created_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/**
 * Locks the invitation, not the organization: the real contention is two
 * requests redeeming one token, and this is the row both of them find.
 */
const LOCK_INVITATION_SQL = `
  SELECT organization_id, email, role
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

export class PostgresOrganizationInvitationRepository
  implements OrganizationInvitationPort
{
  constructor(private readonly client: PostgresIdentityTransactionalClient) {}

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
        // the one-open-invitation index satisfiable.
        await transaction.query(CLOSE_OPEN_INVITATIONS_SQL, [
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

        return { kind: 'created', organizationName: name };
      });
    } catch (error) {
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

        const organizationId = stringValue(invitation, 'organization_id');
        const invitedEmail = stringValue(invitation, 'email');
        const invitedRole = membershipRoleValue(invitation, 'role');
        if (
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
