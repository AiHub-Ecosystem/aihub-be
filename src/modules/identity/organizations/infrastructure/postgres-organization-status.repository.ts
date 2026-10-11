import { AppError } from '@/common/errors/app-error';
import type {
  OrganizationStatusPort,
  SetOrganizationStatusInput,
  SetOrganizationStatusResult,
} from '@/modules/identity/organizations/application/organization-status.port';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { findActiveAccountId } from '@/modules/identity/shared/infrastructure/active-account';
import {
  identityStoreError,
  isRecord,
  organizationStatusValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { organizationKeyHashes } from '@/modules/identity/shared/infrastructure/organization-key-hashes';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const LOCK_ORGANIZATION_SQL = `
  SELECT name, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

/**
 * The operator's side of suspension (ADR-0044). The status and its audit event
 * commit together; the cache purge is the caller's, after commit, so a Redis
 * failure can never undo a recorded act.
 */
export class PostgresOrganizationStatusRepository
  implements OrganizationStatusPort
{
  constructor(
    private readonly client: IdentityRepositoryClient & {
      close(): Promise<void>;
    },
  ) {}

  async setOrganizationStatus(
    input: SetOrganizationStatusInput,
  ): Promise<SetOrganizationStatusResult> {
    try {
      return await this.transact(input);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  private transact(
    input: SetOrganizationStatusInput,
  ): Promise<SetOrganizationStatusResult> {
    return identityTransaction(this.client, async (transaction) => {
      const actorId = await findActiveAccountId(
        transaction,
        input.actorUsername,
      );
      if (actorId === undefined) {
        return { kind: 'actor_invalid' as const };
      }

      const organizationRows = await identityRows(
        transaction,
        LOCK_ORGANIZATION_SQL,
        [input.organizationId],
      );
      const organization = organizationRows[0];
      if (!isRecord(organization)) {
        return { kind: 'organization_not_found' as const };
      }
      const name = stringValue(organization, 'name');
      const status = organizationStatusValue(organization, 'status');
      if (name === undefined || status === undefined) {
        throw identityStoreError('Identity data is invalid');
      }

      const keyHashes = await organizationKeyHashes(
        transaction,
        input.organizationId,
      );

      // A repeat of the applied status is a delivery, not an act.
      if (status === input.status) {
        return { kind: 'unchanged' as const, keyHashes };
      }

      await transaction.organization.update({
        where: { id: input.organizationId },
        data: { status: input.status },
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
          action:
            input.status === 'suspended'
              ? 'organization.suspended'
              : 'organization.restored',
          organizationId: input.organizationId,
          name,
        },
      );

      return { kind: 'changed' as const, keyHashes };
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
