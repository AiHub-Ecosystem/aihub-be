import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';

import { AppError } from '@/common/errors/app-error';
import type {
  CreateOrganizationRecordInput,
  CreateOrganizationRecordResult,
  OrganizationCreationPort,
} from '@/modules/identity/application/organization-creation.port';

import { identityStoreError, isRecord } from './identity-row';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

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

const COUNT_CREATIONS_SQL = `
  SELECT count(*)::int AS creations
  FROM organizations
  WHERE created_by_user_account_id = $1
`;

const INSERT_ORGANIZATION_SQL = `
  INSERT INTO organizations (
    id, name, entitlements, rate_limit_rpm, max_concurrent,
    monthly_request_quota, hard_stop_on_quota, created_by_user_account_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

const INSERT_OWNER_SQL = `
  INSERT INTO organization_members (organization_id, user_account_id, role, status)
  VALUES ($1, $2, 'owner', 'active')
`;

export class PostgresOrganizationCreationRepository
  implements OrganizationCreationPort
{
  constructor(private readonly client: PostgresIdentityTransactionalClient) {}

  async createOrganization(
    input: CreateOrganizationRecordInput,
  ): Promise<CreateOrganizationRecordResult> {
    const organizationId = `org_${ulid()}`;

    try {
      return await this.client.transaction(async (transaction) => {
        const accountRows = await transaction.query(LOCK_ACCOUNT_SQL, [
          input.creatorUserId,
        ]);
        const account = accountRows[0];
        if (!isRecord(account) || account.status !== 'active') {
          return { kind: 'account_inactive' as const };
        }

        const countRows = await transaction.query(COUNT_CREATIONS_SQL, [
          input.creatorUserId,
        ]);
        const countRow = countRows[0];
        if (!isRecord(countRow) || typeof countRow.creations !== 'number') {
          throw identityStoreError('Identity data is invalid');
        }
        if (countRow.creations >= input.creationLimit) {
          // No Organization exists to own an audit event, so the refusal is
          // left as a log line; the requested name stays out of it.
          logger.warn({
            event: 'organization_creation_limit_reached',
            userAccountId: input.creatorUserId,
            requestId: input.context.requestId,
          });
          return { kind: 'limit_reached' as const };
        }

        await transaction.query(INSERT_ORGANIZATION_SQL, [
          organizationId,
          input.name,
          [...input.terms.entitlements],
          input.terms.rateLimitRpm,
          input.terms.maxConcurrent,
          input.terms.monthlyRequestQuota,
          input.terms.hardStopOnQuota,
          input.creatorUserId,
        ]);
        await transaction.query(INSERT_OWNER_SQL, [
          organizationId,
          input.creatorUserId,
        ]);
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
      throw identityStoreError('Identity store is unavailable');
    }
  }
}
