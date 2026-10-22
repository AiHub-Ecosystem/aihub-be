import { AppError } from '@/common/errors/app-error';
import type {
  AttachFirstOwnerInput,
  AttachFirstOwnerResult,
  OrganizationFirstOwnerPort,
} from '@/modules/identity/organizations/application/organization-first-owner.port';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { findActiveAccountId } from '@/modules/identity/shared/infrastructure/active-account';
import {
  identityStoreError,
  identityStoreUnavailable,
  isRecord,
  membershipRoleValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

// The Organization lock serializes attachments: a second one waits here and
// then finds the first one's owner among the active memberships.
const LOCK_ORGANIZATION_SQL = `
  SELECT id
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

/**
 * First Owner Attachment (ADR-0045): the operator's bootstrap for an
 * operator-provisioned Organization that has no active member.
 */
export class PostgresOrganizationFirstOwnerRepository
  implements OrganizationFirstOwnerPort
{
  constructor(
    private readonly client: IdentityRepositoryClient & {
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
      throw identityStoreUnavailable(error);
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private transact(
    input: AttachFirstOwnerInput,
  ): Promise<AttachFirstOwnerResult> {
    return identityTransaction(this.client, async (transaction) => {
      const actorId = await findActiveAccountId(
        transaction,
        input.actorUsername,
      );
      if (actorId === undefined) {
        return { kind: 'actor_invalid' as const };
      }
      // The owner need not have verified their email yet: an unverified
      // account cannot sign in, so attaching it early harms nothing and saves a
      // round trip in the handoff. Only a disabled account is refused
      // (ADR-0045).
      const owner = await transaction.userAccount.findFirst({
        where: {
          username: input.ownerUsername,
          status: { in: ['active', 'pending_verification'] },
        },
        select: { id: true },
      });
      if (owner === null) {
        return { kind: 'owner_invalid' as const };
      }
      const ownerId = owner.id;
      // An operator joining a customer's Organization is the crossing this
      // command exists to make deliberate; another operator must do it.
      if (ownerId === actorId) {
        return { kind: 'actor_is_owner' as const };
      }

      const organizationRows = await identityRows(
        transaction,
        LOCK_ORGANIZATION_SQL,
        [input.organizationId],
      );
      if (!isRecord(organizationRows[0])) {
        return { kind: 'organization_not_found' as const };
      }

      const memberships = (
        await transaction.organizationMembership.findMany({
          where: { organizationId: input.organizationId, status: 'active' },
          select: { userAccountId: true, role: true },
        })
      ).map((row) => {
        const role = membershipRoleValue(row, 'role');
        if (role === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        return { userId: row.userAccountId, role };
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

      // An upsert rather than an insert: a disabled membership of the named
      // account can only exist through hand edits, and reactivating it still
      // ends with exactly one active owner.
      await transaction.organizationMembership.upsert({
        where: {
          organizationId_userAccountId: {
            organizationId: input.organizationId,
            userAccountId: ownerId,
          },
        },
        create: {
          organizationId: input.organizationId,
          userAccountId: ownerId,
          role: 'owner',
          status: 'active',
        },
        update: { role: 'owner', status: 'active' },
      });
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
