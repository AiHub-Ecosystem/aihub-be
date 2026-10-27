import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
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
  identityStoreUnavailable,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import { organizationKeyHashes } from '@/modules/identity/shared/infrastructure/organization-key-hashes';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

const LOCK_ORGANIZATION_SQL = `
  SELECT name, entitlements FROM organizations WHERE id = $1 FOR UPDATE
`;

export class PostgresOrganizationEntitlementRepository
  implements OrganizationEntitlementPort
{
  constructor(
    private readonly client: IdentityRepositoryClient & {
      close(): Promise<void>;
    },
  ) {}

  async grantEntitlement(
    input: GrantOrganizationEntitlementInput,
  ): Promise<GrantOrganizationEntitlementResult> {
    try {
      return await identityTransaction(this.client, async (transaction) => {
        const actorId = await findActiveAccountId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) return { kind: 'actor_invalid' as const };

        const rows = await identityRows(transaction, LOCK_ORGANIZATION_SQL, [
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

        const keyHashes = await organizationKeyHashes(
          transaction,
          input.organizationId,
        );
        if (entitlements.includes(input.entitlement))
          return { kind: 'unchanged' as const, keyHashes };

        await transaction.organization.update({
          where: { id: input.organizationId },
          data: { entitlements: { push: input.entitlement } },
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
      throw identityStoreUnavailable(error);
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
