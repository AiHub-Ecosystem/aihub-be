import { AppError } from '../../../common/errors/app-error';
import type {
  CreateOrganizationApiKeyRecordInput,
  CreateOrganizationApiKeyRecordResult,
  OrganizationApiKeyPort,
} from '../application/organization-api-key.port';

import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

/**
 * Locking the Organization row is what makes the active-key limit hold: two
 * concurrent creations would otherwise both read the same count and both
 * insert. The lock also re-reads `status` and `entitlements` for free, so the
 * suspension and Entitlement guards see the same Organization the limit does.
 */
const LOCK_ORGANIZATION_SQL = `
  SELECT id, status, entitlements
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const COUNT_ACTIVE_KEYS_SQL = `
  SELECT COUNT(*)::int AS active_keys
  FROM api_keys
  WHERE organization_id = $1
    AND status = 'active'
`;

const INSERT_API_KEY_SQL = `
  INSERT INTO api_keys
    (id, organization_id, key_hash, key_prefix, name, scopes,
     allowed_environments, expires_at)
  VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, $7, $8)
  RETURNING created_at
`;

function identityStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArrayValue(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function createdAtValue(value: unknown): Date | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const createdAt = value.created_at;
  if (createdAt instanceof Date && !Number.isNaN(createdAt.getTime())) {
    return new Date(createdAt.getTime());
  }
  if (typeof createdAt === 'string') {
    const parsed = new Date(createdAt);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

export class PostgresOrganizationApiKeyRepository
  implements OrganizationApiKeyPort
{
  constructor(private readonly client: PostgresIdentityTransactionalClient) {}

  async createApiKey(
    input: CreateOrganizationApiKeyRecordInput,
  ): Promise<CreateOrganizationApiKeyRecordResult> {
    if (
      input.context.organizationId !== input.organizationId ||
      input.organizationId.trim().length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.keyHash) ||
      input.scopes.length === 0 ||
      input.allowedEnvironments.length === 0 ||
      !Number.isInteger(input.activeKeyLimit) ||
      input.activeKeyLimit <= 0
    ) {
      throw identityStoreError('Identity API key input is invalid');
    }

    try {
      return await this.client.transaction(async (transaction) => {
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization)) {
          return { kind: 'organization_unavailable' as const };
        }
        if (organization.status !== 'active') {
          return { kind: 'organization_unavailable' as const };
        }

        const entitlements = stringArrayValue(organization, 'entitlements');
        if (entitlements === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        if (
          input.requiredEntitlements.some(
            (entitlement) => !entitlements.includes(entitlement),
          )
        ) {
          return { kind: 'entitlements_missing' as const };
        }

        const countRows = await transaction.query(COUNT_ACTIVE_KEYS_SQL, [
          input.organizationId,
        ]);
        const countRow = countRows[0];
        if (!isRecord(countRow) || typeof countRow.active_keys !== 'number') {
          throw identityStoreError('Identity data is invalid');
        }
        if (countRow.active_keys >= input.activeKeyLimit) {
          return { kind: 'limit_reached' as const };
        }

        const insertedRows = await transaction.query(INSERT_API_KEY_SQL, [
          input.apiKeyId,
          input.organizationId,
          input.keyHash,
          input.keyPrefix,
          input.name,
          [...input.scopes],
          [...input.allowedEnvironments],
          input.expiresAt,
        ]);
        const createdAt = createdAtValue(insertedRows[0]);
        if (createdAt === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        return { kind: 'created' as const, createdAt };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }
}
