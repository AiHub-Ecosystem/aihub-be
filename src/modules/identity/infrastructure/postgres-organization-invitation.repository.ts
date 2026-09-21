import { AppError } from '../../../common/errors/app-error';
import type {
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationResult,
  OrganizationInvitationPort,
} from '../application/organization-invitation.port';

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

function identityStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function organizationName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = value.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
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
}
