import { AppError } from '../../../common/errors/app-error';
import type {
  CreateOrganizationApiKeyRecordInput,
  CreateOrganizationApiKeyRecordResult,
  ListOrganizationApiKeysInput,
  OrganizationApiKeyPort,
  OrganizationApiKeyRecord,
  RevokeOrganizationApiKeyRecordInput,
  RevokeOrganizationApiKeyRecordResult,
  RotateOrganizationApiKeyRecordInput,
  RotateOrganizationApiKeyRecordResult,
} from '../application/organization-api-key.port';

import type { OrganizationAuditStamp } from '../domain/organization-audit-event';

import { recordOrganizationAuditEvent } from './organization-audit-event.store';
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

/**
 * The live-credential inventory. Revoked rows stay durable and unlisted, and
 * the organization predicate is the only thing standing between one tenant and
 * another's key inventory. Ordering is newest-first with the identifier as
 * tie-break, which agrees with the primary sort because the identifier is
 * time-ordered.
 */
const LIST_API_KEYS_SQL = `
  SELECT
    id,
    name,
    key_prefix,
    scopes,
    allowed_environments,
    status,
    expires_at,
    last_used_at,
    created_at
  FROM api_keys
  WHERE organization_id = $1
    AND status = 'active'
  ORDER BY created_at DESC, id DESC
`;

/**
 * Claims the key being retired. Without this lock two concurrent rotations
 * both read it as active, both revoke it, and both insert, leaving the
 * Organization with two live replacements where one was asked for.
 *
 * The rotatability guard runs here, under the lock, but against the clock the
 * application passes in: the canonical form of the rule is `apiKeyStatus` in
 * the domain, and the database's own clock never decides it.
 */
const LOCK_API_KEY_SQL = `
  SELECT
    encode(key_hash, 'hex') AS key_hash_hex,
    name,
    scopes,
    allowed_environments,
    status,
    expires_at
  FROM api_keys
  WHERE id = $1
    AND organization_id = $2
  FOR UPDATE
`;

const REVOKE_API_KEY_SQL = `
  UPDATE api_keys
  SET status = 'revoked', revoked_at = $2
  WHERE id = $1
`;

/**
 * The replacement inherits every column that describes what the key may do.
 * Rotation is exempt from the active-key cap: it never changes how many active
 * keys an Organization holds, and an Organization at its cap must still be
 * able to replace a leaked credential.
 */
const INSERT_REPLACEMENT_SQL = `
  INSERT INTO api_keys
    (id, organization_id, key_hash, key_prefix, name, scopes,
     allowed_environments, expires_at)
  VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, $7, $8)
  RETURNING created_at
`;

/**
 * Claims the key so a withdrawal cannot read a row that rotation is in the
 * middle of replacing. Two concurrent withdrawals need no protection — they
 * agree — so this lock is here for the race against rotation, not for itself.
 */
const LOCK_API_KEY_FOR_REVOKE_SQL = `
  SELECT
    encode(key_hash, 'hex') AS key_hash_hex,
    id,
    name,
    key_prefix,
    scopes,
    allowed_environments,
    status,
    expires_at,
    last_used_at,
    created_at
  FROM api_keys
  WHERE id = $1
    AND organization_id = $2
  FOR UPDATE
`;

/**
 * Only an active key is changed. A key already withdrawn keeps the moment it
 * was withdrawn at: the record should say when the credential actually stopped
 * working, not when somebody last asked for it again.
 */
const REVOKE_ACTIVE_API_KEY_SQL = `
  UPDATE api_keys
  SET status = 'revoked', revoked_at = $2
  WHERE id = $1
    AND status = 'active'
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

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function mapListRow(value: unknown): OrganizationApiKeyRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const apiKeyId = stringValue(value, 'id');
  const name = stringValue(value, 'name');
  const keyPrefix = stringValue(value, 'key_prefix');
  const scopes = stringArrayValue(value, 'scopes');
  const allowedEnvironments = stringArrayValue(value, 'allowed_environments');
  const expiresAt = dateValue(value, 'expires_at');
  const lastUsedAt = dateValue(value, 'last_used_at');
  const createdAt = dateValue(value, 'created_at');

  // Mapped from the row rather than hardcoded to the value the query happens
  // to select: the filter belongs in one place, and a mapper that contradicts
  // a widened query would fail the request instead of reporting the row.
  const status =
    value.status === 'active' || value.status === 'revoked'
      ? value.status
      : undefined;

  if (
    apiKeyId === undefined ||
    name === undefined ||
    keyPrefix === undefined ||
    scopes === undefined ||
    allowedEnvironments === undefined ||
    status === undefined ||
    expiresAt === undefined ||
    lastUsedAt === undefined ||
    createdAt === undefined ||
    createdAt === null
  ) {
    return undefined;
  }

  return {
    apiKeyId,
    name,
    keyPrefix,
    scopes,
    allowedEnvironments,
    status,
    expiresAt,
    lastUsedAt,
    createdAt,
  };
}

export class PostgresOrganizationApiKeyRepository
  implements OrganizationApiKeyPort
{
  constructor(private readonly client: PostgresIdentityTransactionalClient) {}

  async rotateApiKey(
    input: RotateOrganizationApiKeyRecordInput,
  ): Promise<RotateOrganizationApiKeyRecordResult> {
    if (
      input.context.organizationId !== input.organizationId ||
      input.organizationId.trim().length === 0 ||
      input.apiKeyId.trim().length === 0 ||
      input.replacementId.trim().length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.keyHash)
    ) {
      throw identityStoreError('Identity API key rotation input is invalid');
    }

    try {
      return await this.client.transaction(async (transaction) => {
        // Organization first, then key: creation takes the same order, so two
        // key mutations cannot deadlock against each other.
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization) || organization.status !== 'active') {
          return { kind: 'organization_unavailable' as const };
        }

        const keyRows = await transaction.query(LOCK_API_KEY_SQL, [
          input.apiKeyId,
          input.organizationId,
        ]);
        const key = keyRows[0];
        if (!isRecord(key)) {
          return { kind: 'key_not_found' as const };
        }

        const retiredKeyHash = stringValue(key, 'key_hash_hex');
        const name = stringValue(key, 'name');
        const scopes = stringArrayValue(key, 'scopes');
        const allowedEnvironments = stringArrayValue(
          key,
          'allowed_environments',
        );
        const expiresAt = dateValue(key, 'expires_at');
        if (
          retiredKeyHash === undefined ||
          name === undefined ||
          scopes === undefined ||
          allowedEnvironments === undefined ||
          expiresAt === undefined
        ) {
          throw identityStoreError('Identity data is invalid');
        }

        if (
          key.status !== 'active' ||
          (expiresAt !== null && expiresAt.getTime() <= input.now.getTime())
        ) {
          return { kind: 'key_not_rotatable' as const };
        }

        await transaction.query(REVOKE_API_KEY_SQL, [
          input.apiKeyId,
          input.now,
        ]);

        const insertedRows = await transaction.query(INSERT_REPLACEMENT_SQL, [
          input.replacementId,
          input.organizationId,
          input.keyHash,
          input.keyPrefix,
          name,
          [...scopes],
          [...allowedEnvironments],
          expiresAt,
        ]);
        const createdAt = createdAtValue(insertedRows[0]);
        if (createdAt === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        await recordOrganizationAuditEvent(
          transaction,
          {
            organizationId: input.organizationId,
            actorUserAccountId: input.actorUserId,
            requestId: input.context.requestId,
            occurredAt: input.now,
          } satisfies Omit<OrganizationAuditStamp, 'id'>,
          {
            action: 'api_key.rotated',
            apiKeyId: input.apiKeyId,
            name,
            replacementId: input.replacementId,
            replacementKeyPrefix: input.keyPrefix,
            scopes,
            allowedEnvironments,
          },
        );

        return {
          kind: 'rotated' as const,
          retiredKeyHash,
          name,
          scopes,
          allowedEnvironments,
          expiresAt,
          createdAt,
        };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async revokeApiKey(
    input: RevokeOrganizationApiKeyRecordInput,
  ): Promise<RevokeOrganizationApiKeyRecordResult> {
    if (
      input.context.organizationId !== input.organizationId ||
      input.organizationId.trim().length === 0 ||
      input.apiKeyId.trim().length === 0
    ) {
      throw identityStoreError('Identity API key revocation input is invalid');
    }

    try {
      return await this.client.transaction(async (transaction) => {
        // Organization first, then key: the order creation and rotation use,
        // so key mutations cannot deadlock against each other.
        const organizationRows = await transaction.query(
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization) || organization.status !== 'active') {
          return { kind: 'organization_unavailable' as const };
        }

        const keyRows = await transaction.query(LOCK_API_KEY_FOR_REVOKE_SQL, [
          input.apiKeyId,
          input.organizationId,
        ]);
        const row = keyRows[0];
        if (!isRecord(row)) {
          return { kind: 'key_not_found' as const };
        }

        const keyHash = stringValue(row, 'key_hash_hex');
        if (keyHash === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        await transaction.query(REVOKE_ACTIVE_API_KEY_SQL, [
          input.apiKeyId,
          input.now,
        ]);

        // Reported as withdrawn whether this request changed it or a previous
        // one did: revocation is state-idempotent.
        const key = mapListRow({ ...row, status: 'revoked' });
        if (key === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        // Only the request that actually withdrew the key is an act. The
        // repeat that finds it already withdrawn changed nothing, and a trail
        // that records deliveries is diluted by the retries this boundary
        // deliberately invites.
        if (row.status === 'active') {
          await recordOrganizationAuditEvent(
            transaction,
            {
              organizationId: input.organizationId,
              actorUserAccountId: input.actorUserId,
              requestId: input.context.requestId,
              occurredAt: input.now,
            } satisfies Omit<OrganizationAuditStamp, 'id'>,
            {
              action: 'api_key.revoked',
              apiKeyId: key.apiKeyId,
              name: key.name,
              keyPrefix: key.keyPrefix,
            },
          );
        }

        return { kind: 'revoked' as const, keyHash, key };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async listApiKeys(
    input: ListOrganizationApiKeysInput,
  ): Promise<readonly OrganizationApiKeyRecord[]> {
    if (
      input.context.organizationId !== input.organizationId ||
      input.organizationId.trim().length === 0
    ) {
      throw identityStoreError('Identity API key query is invalid');
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LIST_API_KEYS_SQL, [input.organizationId]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    // An invalid projection fails the whole request rather than quietly
    // yielding a partial inventory.
    return rows.map((row) => {
      const record = mapListRow(row);
      if (record === undefined) {
        throw identityStoreError('Identity data is invalid');
      }
      return record;
    });
  }

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

        await recordOrganizationAuditEvent(
          transaction,
          {
            organizationId: input.organizationId,
            actorUserAccountId: input.actorUserId,
            requestId: input.context.requestId,
            occurredAt: createdAt,
          } satisfies Omit<OrganizationAuditStamp, 'id'>,
          {
            action: 'api_key.created',
            apiKeyId: input.apiKeyId,
            name: input.name,
            keyPrefix: input.keyPrefix,
            scopes: input.scopes,
            allowedEnvironments: input.allowedEnvironments,
          },
        );

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
