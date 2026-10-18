import { AppError } from '@/common/errors/app-error';
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
} from '@/modules/identity/api-keys/application/organization-api-key.port';
import { dateValue } from '@/modules/identity/shared/infrastructure/identity-row';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { isOrganizationContextAllowed } from '@/modules/identity/shared/infrastructure/organization-context-policy';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

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

/**
 * The columns an inventory entry is built from. The list query selects exactly
 * these, and the revoke path's locked row is aliased to the same names, so one
 * mapper serves both.
 */
const INVENTORY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  allowedEnvironments: true,
  status: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

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
    key_prefix,
    scopes,
    allowed_environments,
    status,
    expires_at
  FROM api_keys
  WHERE id = $1
    AND organization_id = $2
  FOR UPDATE
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
    key_prefix AS "keyPrefix",
    scopes,
    allowed_environments AS "allowedEnvironments",
    status,
    expires_at AS "expiresAt",
    last_used_at AS "lastUsedAt",
    created_at AS "createdAt"
  FROM api_keys
  WHERE id = $1
    AND organization_id = $2
  FOR UPDATE
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

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapListRow(value: unknown): OrganizationApiKeyRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const apiKeyId = stringValue(value, 'id');
  const name = stringValue(value, 'name');
  const keyPrefix = stringValue(value, 'keyPrefix');
  const scopes = stringArrayValue(value, 'scopes');
  const allowedEnvironments = stringArrayValue(value, 'allowedEnvironments');
  const expiresAt = dateValue(value, 'expiresAt');
  const lastUsedAt = dateValue(value, 'lastUsedAt');
  const createdAt = dateValue(value, 'createdAt');

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
    expiresAt: expiresAt ?? null,
    lastUsedAt,
    createdAt,
  };
}

export class PostgresOrganizationApiKeyRepository
  implements OrganizationApiKeyPort
{
  constructor(private readonly client: IdentityRepositoryClient) {}

  async rotateApiKey(
    input: RotateOrganizationApiKeyRecordInput,
  ): Promise<RotateOrganizationApiKeyRecordResult> {
    if (
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.organizationId.trim().length === 0 ||
      input.apiKeyId.trim().length === 0 ||
      input.replacementId.trim().length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.keyHash)
    ) {
      throw identityStoreError('Identity API key rotation input is invalid');
    }

    try {
      return await identityTransaction(this.client, async (transaction) => {
        // Organization first, then key: creation takes the same order, so two
        // key mutations cannot deadlock against each other.
        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization) || organization.status !== 'active') {
          return { kind: 'organization_unavailable' as const };
        }

        const keyRows = await identityRows(transaction, LOCK_API_KEY_SQL, [
          input.apiKeyId,
          input.organizationId,
        ]);
        const key = keyRows[0];
        if (!isRecord(key)) {
          return { kind: 'key_not_found' as const };
        }

        const retiredKeyHash = stringValue(key, 'key_hash_hex');
        const retiredKeyPrefix = stringValue(key, 'key_prefix');
        const name = stringValue(key, 'name');
        const scopes = stringArrayValue(key, 'scopes');
        const allowedEnvironments = stringArrayValue(
          key,
          'allowed_environments',
        );
        const expiresAt = dateValue(key, 'expires_at');
        if (
          retiredKeyHash === undefined ||
          retiredKeyPrefix === undefined ||
          name === undefined ||
          scopes === undefined ||
          allowedEnvironments === undefined ||
          // `undefined` is an unreadable value; `null` is a key with no expiry.
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

        // The replacement was chosen from the allowlist the application read;
        // a changed allowlist means that choice may no longer be valid.
        if (
          allowedEnvironments.join(',') !==
          input.retiredAllowedEnvironments.join(',')
        ) {
          return { kind: 'key_not_rotatable' as const };
        }

        await transaction.apiKey.updateMany({
          where: { id: input.apiKeyId },
          data: { status: 'revoked', revokedAt: input.now },
        });

        // Rotation narrows environment authority to one. It is exempt from the
        // active-key cap because it never changes how many keys are active.
        const { createdAt } = await transaction.apiKey.create({
          data: {
            id: input.replacementId,
            organizationId: input.organizationId,
            keyHash: Buffer.from(input.keyHash, 'hex'),
            keyPrefix: input.keyPrefix,
            name,
            scopes: [...scopes],
            allowedEnvironments: [...input.replacementAllowedEnvironments],
            expiresAt: expiresAt ?? null,
          },
          select: { createdAt: true },
        });

        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(input, input.actorUserId, input.now),
          {
            action: 'api_key.rotated',
            apiKeyId: input.apiKeyId,
            name,
            keyPrefix: retiredKeyPrefix,
            replacementId: input.replacementId,
            replacementKeyPrefix: input.keyPrefix,
            scopes,
            allowedEnvironments: input.replacementAllowedEnvironments,
          },
        );

        return {
          kind: 'rotated' as const,
          retiredKeyHash,
          name,
          scopes,
          allowedEnvironments: [...input.replacementAllowedEnvironments],
          expiresAt: expiresAt ?? null,
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
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.organizationId.trim().length === 0 ||
      input.apiKeyId.trim().length === 0
    ) {
      throw identityStoreError('Identity API key revocation input is invalid');
    }

    try {
      return await identityTransaction(this.client, async (transaction) => {
        // Organization first, then key: the order creation and rotation use,
        // so key mutations cannot deadlock against each other.
        const organizationRows = await identityRows(
          transaction,
          LOCK_ORGANIZATION_SQL,
          [input.organizationId],
        );
        const organization = organizationRows[0];
        if (!isRecord(organization) || organization.status !== 'active') {
          return { kind: 'organization_unavailable' as const };
        }

        const keyRows = await identityRows(
          transaction,
          LOCK_API_KEY_FOR_REVOKE_SQL,
          [input.apiKeyId, input.organizationId],
        );
        const row = keyRows[0];
        if (!isRecord(row)) {
          return { kind: 'key_not_found' as const };
        }

        const keyHash = stringValue(row, 'key_hash_hex');
        if (keyHash === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        // Only an active key is changed. A key already withdrawn keeps the
        // moment it was withdrawn at: the record should say when the credential
        // actually stopped working, not when somebody last asked for it again.
        await transaction.apiKey.updateMany({
          where: { id: input.apiKeyId, status: 'active' },
          data: { status: 'revoked', revokedAt: input.now },
        });

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
            auditStamp(input, input.actorUserId, input.now),
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
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
      input.organizationId.trim().length === 0
    ) {
      throw identityStoreError('Identity API key query is invalid');
    }

    // The live-credential inventory. Revoked rows stay durable and unlisted,
    // and the organization predicate is the only thing standing between one
    // tenant and another's key inventory. Ordering is newest-first with the
    // identifier as a deterministic tie-break. Same-millisecond mint order is
    // process-local and does not imply commit order.
    let rows: readonly unknown[];
    try {
      rows = await this.client.apiKey.findMany({
        where: { organizationId: input.organizationId, status: 'active' },
        select: INVENTORY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
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
      !isOrganizationContextAllowed(input.context, {
        kind: 'required',
        organizationId: input.organizationId,
      }) ||
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
      return await identityTransaction(this.client, async (transaction) => {
        const organizationRows = await identityRows(
          transaction,
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

        const activeKeys = await transaction.apiKey.count({
          where: { organizationId: input.organizationId, status: 'active' },
        });
        if (activeKeys >= input.activeKeyLimit) {
          return { kind: 'limit_reached' as const };
        }

        const { createdAt } = await transaction.apiKey.create({
          data: {
            id: input.apiKeyId,
            organizationId: input.organizationId,
            keyHash: Buffer.from(input.keyHash, 'hex'),
            keyPrefix: input.keyPrefix,
            name: input.name,
            scopes: [...input.scopes],
            allowedEnvironments: [...input.allowedEnvironments],
            expiresAt: input.expiresAt,
          },
          select: { createdAt: true },
        });

        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(input, input.actorUserId, createdAt),
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
