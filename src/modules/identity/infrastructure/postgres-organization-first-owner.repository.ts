import { AppError } from '../../../common/errors/app-error';
import type {
  AttachFirstOwnerInput,
  AttachFirstOwnerResult,
  OrganizationFirstOwnerPort,
} from '../application/organization-first-owner.port';

import { findActiveAccountId } from './active-account';
import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  stringValue,
} from './identity-row';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

// The owner need not have verified their email yet: an unverified account
// cannot sign in, so attaching it early harms nothing and saves a round trip
// in the handoff. Only a disabled account is refused (ADR-0045).
const ATTACHABLE_ACCOUNT_BY_USERNAME_SQL = `
  SELECT id
  FROM user_accounts
  WHERE username = $1
    AND status IN ('active', 'pending_verification')
`;

// The Organization lock serializes attachments: a second one waits here and
// then finds the first one's owner among the active memberships.
const LOCK_ORGANIZATION_SQL = `
  SELECT id
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const ACTIVE_MEMBERSHIPS_SQL = `
  SELECT user_account_id, role
  FROM organization_members
  WHERE organization_id = $1
    AND status = 'active'
`;

// An upsert rather than an insert: a disabled membership of the named account
// can only exist through hand edits, and reactivating it still ends with
// exactly one active owner.
const UPSERT_OWNER_SQL = `
  INSERT INTO organization_members
    (organization_id, user_account_id, role, status)
  VALUES ($1, $2, 'owner', 'active')
  ON CONFLICT (organization_id, user_account_id)
  DO UPDATE SET role = 'owner', status = 'active'
`;

/**
 * First Owner Attachment (ADR-0045): the operator's bootstrap for an
 * operator-provisioned Organization that has no active member.
 */
export class PostgresOrganizationFirstOwnerRepository
  implements OrganizationFirstOwnerPort
{
  constructor(
    private readonly client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    },
  ) {}

  async attachFirstOwner(
    input: AttachFirstOwnerInput,
  ): Promise<AttachFirstOwnerResult> {
    try {
      return await this.transact(input);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private transact(
    input: AttachFirstOwnerInput,
  ): Promise<AttachFirstOwnerResult> {
    return this.client.transaction(async (transaction) => {
      const accountId = async (
        sql: string,
        username: string,
      ): Promise<string | undefined> => {
        const rows = await transaction.query(sql, [username]);
        const row = rows[0];
        return isRecord(row) ? stringValue(row, 'id') : undefined;
      };

      const actorId = await findActiveAccountId(
        transaction,
        input.actorUsername,
      );
      if (actorId === undefined) {
        return { kind: 'actor_invalid' as const };
      }
      const ownerId = await accountId(
        ATTACHABLE_ACCOUNT_BY_USERNAME_SQL,
        input.ownerUsername,
      );
      if (ownerId === undefined) {
        return { kind: 'owner_invalid' as const };
      }
      // An operator joining a customer's Organization is the crossing this
      // command exists to make deliberate; another operator must do it.
      if (ownerId === actorId) {
        return { kind: 'actor_is_owner' as const };
      }

      const organizationRows = await transaction.query(LOCK_ORGANIZATION_SQL, [
        input.organizationId,
      ]);
      if (!isRecord(organizationRows[0])) {
        return { kind: 'organization_not_found' as const };
      }

      const memberships = (
        await transaction.query(ACTIVE_MEMBERSHIPS_SQL, [input.organizationId])
      ).map((row) => {
        const userId = isRecord(row)
          ? stringValue(row, 'user_account_id')
          : undefined;
        const role = isRecord(row)
          ? membershipRoleValue(row, 'role')
          : undefined;
        if (userId === undefined || role === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        return { userId, role };
      });

      const [only] = memberships;
      if (
        memberships.length === 1 &&
        only?.userId === ownerId &&
        only.role === 'owner'
      ) {
        return { kind: 'unchanged' as const };
      }
      if (memberships.length > 0) {
        return { kind: 'organization_has_members' as const };
      }

      await transaction.query(UPSERT_OWNER_SQL, [
        input.organizationId,
        ownerId,
      ]);
      await recordOrganizationAuditEvent(
        transaction,
        auditStamp(
          {
            context: { requestId: input.requestId },
            organizationId: input.organizationId,
          },
          actorId,
          input.occurredAt,
        ),
        {
          action: 'membership.owner_attached',
          targetUserAccountId: ownerId,
          username: input.ownerUsername,
        },
      );

      return { kind: 'attached' as const };
    });
  }
}
