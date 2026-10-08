import { AppError } from '@/common/errors/app-error';
import type {
  CreateOperatorApiKeyInput,
  CreateOperatorApiKeyResult,
  OperatorApiKeyPort,
  RevokeOperatorApiKeyInput,
  RevokeOperatorApiKeyResult,
} from '@/modules/identity/api-keys/application/operator-api-key.port';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import { findActiveAccountId } from '@/modules/identity/shared/infrastructure/active-account';
import {
  identityStoreError,
  isRecord,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import type { PostgresIdentityTransactionalClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

// Creation keeps the operator CLI's own rule: the Organization must be active.
// Entitlements and the active-key cap are the Bearer path's, not this one's.
const LOCK_ACTIVE_ORGANIZATION_SQL = `
  SELECT 1
  FROM organizations
  WHERE id = $1
    AND status = 'active'
  FOR UPDATE
`;

const INSERT_API_KEY_SQL = `
  INSERT INTO api_keys
    (id, organization_id, key_hash, key_prefix, name, scopes,
     allowed_environments)
  VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, $7)
`;

// Locked on the key alone: an operator revokes by key id, and does so for an
// Organization in any status, including one that was suspended because a key
// leaked.
const LOCK_API_KEY_SQL = `
  SELECT
    organization_id,
    encode(key_hash, 'hex') AS hash_hex,
    name,
    key_prefix,
    status
  FROM api_keys
  WHERE id = $1
  FOR UPDATE
`;

// Only an active key changes, so a repeat keeps the moment the credential
// actually stopped working.
const REVOKE_ACTIVE_API_KEY_SQL = `
  UPDATE api_keys
  SET status = 'revoked', revoked_at = $2
  WHERE id = $1
    AND status = 'active'
`;

/**
 * The operator's side of key issuance and revocation. Each act and its audit
 * event commit together; the cache purge is the caller's, after commit, so a
 * Redis failure can never undo a recorded act.
 */
export class PostgresOperatorApiKeyRepository implements OperatorApiKeyPort {
  constructor(
    private readonly client: PostgresIdentityTransactionalClient & {
      close(): Promise<void>;
    },
  ) {}

  async createApiKey(
    input: CreateOperatorApiKeyInput,
  ): Promise<CreateOperatorApiKeyResult> {
    try {
      return await this.client.transaction(async (transaction) => {
        const actorId = await findActiveAccountId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) {
          return { kind: 'actor_invalid' as const };
        }

        const organizationRows = await transaction.query(
          LOCK_ACTIVE_ORGANIZATION_SQL,
          [input.organizationId],
        );
        if (organizationRows.length !== 1) {
          return { kind: 'organization_unavailable' as const };
        }

        await transaction.query(INSERT_API_KEY_SQL, [
          input.apiKeyId,
          input.organizationId,
          input.keyHash,
          input.keyPrefix,
          input.name,
          [...input.scopes],
          [...input.allowedEnvironments],
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
            action: 'api_key.created',
            apiKeyId: input.apiKeyId,
            name: input.name,
            keyPrefix: input.keyPrefix,
            scopes: input.scopes,
            allowedEnvironments: input.allowedEnvironments,
          },
        );

        return { kind: 'created' as const };
      });
    } catch (error) {
      throw this.storeError(error);
    }
  }

  async revokeApiKey(
    input: RevokeOperatorApiKeyInput,
  ): Promise<RevokeOperatorApiKeyResult> {
    try {
      return await this.client.transaction(async (transaction) => {
        const actorId = await findActiveAccountId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) {
          return { kind: 'actor_invalid' as const };
        }

        const keyRows = await transaction.query(LOCK_API_KEY_SQL, [
          input.apiKeyId,
        ]);
        const row = keyRows[0];
        if (!isRecord(row)) {
          return { kind: 'key_not_found' as const };
        }
        const organizationId = stringValue(row, 'organization_id');
        const keyHash = stringValue(row, 'hash_hex');
        const name = stringValue(row, 'name');
        const keyPrefix = stringValue(row, 'key_prefix');
        if (
          organizationId === undefined ||
          keyHash === undefined ||
          name === undefined ||
          keyPrefix === undefined
        ) {
          throw identityStoreError('Identity data is invalid');
        }

        // A repeat is a delivery, not an act: it records nothing.
        if (row.status !== 'active') {
          return { kind: 'unchanged' as const, keyHash };
        }

        await transaction.query(REVOKE_ACTIVE_API_KEY_SQL, [
          input.apiKeyId,
          input.occurredAt,
        ]);
        await recordOrganizationAuditEvent(
          transaction,
          auditStamp(
            { context: { requestId: input.requestId }, organizationId },
            actorId,
            input.occurredAt,
          ),
          {
            action: 'api_key.revoked',
            apiKeyId: input.apiKeyId,
            name,
            keyPrefix,
          },
        );

        return { kind: 'revoked' as const, keyHash };
      });
    } catch (error) {
      throw this.storeError(error);
    }
  }

  close(): Promise<void> {
    return this.client.close();
  }

  private storeError(error: unknown): AppError {
    return error instanceof AppError
      ? error
      : identityStoreError('Identity store is unavailable');
  }
}
