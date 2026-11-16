import { AppError } from '@/common/errors/app-error';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import type {
  OrganizationIdentityIssuerReleasePort,
  ReleaseOrganizationIdentityIssuerInput,
  ReleaseOrganizationIdentityIssuerResult,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-issuer-release.port';
import { findActiveAccountId } from '@/modules/identity/shared/infrastructure/active-account';
import {
  identityStoreUnavailable,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

export class PostgresOrganizationIdentityIssuerReleaseRepository
  implements OrganizationIdentityIssuerReleasePort
{
  constructor(
    private readonly client: IdentityRepositoryClient & {
      close(): Promise<void>;
    },
  ) {}

  async releaseIssuer(
    input: ReleaseOrganizationIdentityIssuerInput,
  ): Promise<ReleaseOrganizationIdentityIssuerResult> {
    try {
      return await identityTransaction(
        this.client,
        input.organizationId,
        async (transaction) => {
          const actorId = await findActiveAccountId(
            transaction,
            input.actorUsername,
          );
          if (actorId === undefined) {
            return { kind: 'actor_invalid' as const };
          }

          const organizations = await identityRows(
            transaction,
            'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
            [input.organizationId],
          );
          if (organizations.length === 0) {
            return { kind: 'organization_not_found' as const };
          }

          const configs = await identityRows(
            transaction,
            `SELECT issuer FROM organization_identity_configs
           WHERE organization_id = $1 AND issuer_claimed FOR UPDATE`,
            [input.organizationId],
          );
          const config = configs[0];
          const issuer =
            config === undefined ? undefined : stringValue(config, 'issuer');
          if (issuer === undefined) {
            return { kind: 'issuer_unclaimed' as const };
          }

          await identityRows(
            transaction,
            `UPDATE organization_identity_configs
           SET issuer_claimed = false,
               status = 'disabled',
               jwks_cache_version = jwks_cache_version + 1
           WHERE organization_id = $1`,
            [input.organizationId],
          );
          await recordOrganizationAuditEvent(
            transaction,
            auditStamp(
              {
                context: { requestId: input.requestId },
                organizationId: input.organizationId,
              },
              actorId,
              input.occurredAt,
              'self_declared_operator',
            ),
            {
              action: 'organization.identity_issuer_released',
              organizationId: input.organizationId,
              issuer,
            },
          );
          return { kind: 'released' as const };
        },
      );
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
}
