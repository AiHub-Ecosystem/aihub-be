import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';

import { AppError } from '@/common/errors/app-error';
import type {
  CreateOrganizationRecordInput,
  CreateOrganizationRecordResult,
  OrganizationCreationRecordPort,
} from '@/modules/identity/organizations/application/organization-creation-record.port';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import {
  identityStoreUnavailable,
  isRecord,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

/**
 * The account row is the lock: every creation by one account serializes on it,
 * so two concurrent requests cannot both count below the limit and both insert.
 * It also re-reads the status the Bearer guard checked, in case the account was
 * disabled between the guard and this transaction.
 */
const logger = new Logger('OrganizationCreation');

const LOCK_ACCOUNT_SQL = `
  SELECT status
  FROM user_accounts
  WHERE id = $1
  FOR UPDATE
`;

export class PostgresOrganizationCreationRepository
  implements OrganizationCreationRecordPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<CreateOrganizationRecordResult> {
    const organizationId = `org_${ulid()}`;

    try {
      return await identityTransaction(this.client, async (transaction) => {
        const accountRows = await identityRows(transaction, LOCK_ACCOUNT_SQL, [
          input.creatorUserId,
        ]);
        const account = accountRows[0];
        if (!isRecord(account) || account.status !== 'active') {
          return { kind: 'account_inactive' as const };
        }

        const creations = await transaction.organization.count({
          where: { createdByUserAccountId: input.creatorUserId },
        });
        if (creations >= input.creationLimit) {
          // No Organization exists to own an audit event, so the refusal is
          // left as a log line; the requested name stays out of it.
          logger.warn({
            event: 'organization_creation_limit_reached',
            userAccountId: input.creatorUserId,
            requestId: input.context.requestId,
          });
          return { kind: 'limit_reached' as const };
        }

        await transaction.organization.create({
          data: {
            id: organizationId,
            name: input.name,
            entitlements: [...input.terms.entitlements],
            rateLimitRpm: input.terms.rateLimitRpm,
            maxConcurrent: input.terms.maxConcurrent,
            monthlyRequestQuota: input.terms.monthlyRequestQuota,
            hardStopOnQuota: input.terms.hardStopOnQuota,
            createdByUserAccountId: input.creatorUserId,
          },
        });
        await transaction.organizationMembership.create({
          data: {
            organizationId,
            userAccountId: input.creatorUserId,
            role: 'owner',
            status: 'active',
          },
        });
        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(
            { context: input.context, organizationId },
            input.creatorUserId,
            input.context.receivedAt,
          ),
          { action: 'organization.created', organizationId, name: input.name },
        );

        return { kind: 'created' as const, organizationId };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreUnavailable(error);
    }
  }
}
