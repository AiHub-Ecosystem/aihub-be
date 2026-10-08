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
import type { PostgresIdentityTransactionalClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const LOCK_ORGANIZATION_SQL = `
  SELECT name, status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const SET_STATUS_SQL = `
  UPDATE organizations
  SET status = $2
  WHERE id = $1
`;

// Every key, whatever its own status: a revoked key's cached record is gone
// already, so purging it again costs one delete and removes a special case.
const ORGANIZATION_KEY_HASHES_SQL = `
  SELECT encode(key_hash, 'hex') AS hash_hex
  FROM api_keys
  WHERE organization_id = $1
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
    private readonly client: PostgresIdentityTransactionalClient & {
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
    return this.client.transaction(async (transaction) => {
      const actorId = await findActiveAccountId(
        transaction,
        input.actorUsername,
      );
      if (actorId === undefined) {
        return { kind: 'actor_invalid' as const };
      }

      const organizationRows = await transaction.query(LOCK_ORGANIZATION_SQL, [
        input.organizationId,
      ]);
      const organization = organizationRows[0];
      if (!isRecord(organization)) {
        return { kind: 'organization_not_found' as const };
      }
      const name = stringValue(organization, 'name');
      const status = organizationStatusValue(organization, 'status');
      if (name === undefined || status === undefined) {
        throw identityStoreError('Identity data is invalid');
      }

      const hashRows = await transaction.query(ORGANIZATION_KEY_HASHES_SQL, [
        input.organizationId,
      ]);
      const keyHashes = hashRows.map((row) => {
        const hash = isRecord(row) ? stringValue(row, 'hash_hex') : undefined;
        if (hash === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        return hash;
      });

      // A repeat of the applied status is a delivery, not an act.
      if (status === input.status) {
        return { kind: 'unchanged' as const, keyHashes };
      }

      await transaction.query(SET_STATUS_SQL, [
        input.organizationId,
        input.status,
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
