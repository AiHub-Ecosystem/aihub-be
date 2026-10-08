import { AppError } from '@/common/errors/app-error';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import type {
  GrantOrganizationEntitlementInput,
  GrantOrganizationEntitlementResult,
  OrganizationEntitlementPort,
} from '@/modules/identity/organizations/application/organization-entitlement.port';
import { findActiveAccountId } from '@/modules/identity/shared/infrastructure/active-account';
import {
  identityStoreError,
  isRecord,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import type { PostgresIdentityTransactionalClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const LOCK_ORGANIZATION_SQL = `
  SELECT name, entitlements FROM organizations WHERE id = $1 FOR UPDATE
`;
const GRANT_ENTITLEMENT_SQL = `
  UPDATE organizations SET entitlements = array_append(entitlements, $2) WHERE id = $1
`;
const ORGANIZATION_KEY_HASHES_SQL = `
  SELECT encode(key_hash, 'hex') AS hash_hex FROM api_keys WHERE organization_id = $1
`;

export class PostgresOrganizationEntitlementRepository
  implements OrganizationEntitlementPort
{
  constructor(
    private readonly client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    },
  ) {}

  async grantEntitlement(
    input: GrantOrganizationEntitlementInput,
  ): Promise<GrantOrganizationEntitlementResult> {
    try {
      return await this.client.transaction(async (transaction) => {
        const actorId = await findActiveAccountId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) return { kind: 'actor_invalid' as const };

        const rows = await transaction.query(LOCK_ORGANIZATION_SQL, [
          input.organizationId,
        ]);
        const organization = rows[0];
        if (!isRecord(organization))
          return { kind: 'organization_not_found' as const };
        const name = stringValue(organization, 'name');
        const entitlements = organization.entitlements;
        if (
          name === undefined ||
          !Array.isArray(entitlements) ||
          !entitlements.every((value) => typeof value === 'string')
        ) {
          throw identityStoreError('Identity data is invalid');
        }

        const keyRows = await transaction.query(ORGANIZATION_KEY_HASHES_SQL, [
          input.organizationId,
        ]);
        const keyHashes = keyRows.map((row) => {
          const hash = isRecord(row) ? stringValue(row, 'hash_hex') : undefined;
          if (hash === undefined)
            throw identityStoreError('Identity data is invalid');
          return hash;
        });
        if (entitlements.includes(input.entitlement))
          return { kind: 'unchanged' as const, keyHashes };

        await transaction.query(GRANT_ENTITLEMENT_SQL, [
          input.organizationId,
          input.entitlement,
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
            action: 'organization.entitlement_granted',
            organizationId: input.organizationId,
            name,
            entitlement: input.entitlement,
          },
        );
        return { kind: 'granted' as const, keyHashes };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw identityStoreError('Identity store is unavailable');
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
