import { AppError } from '../../../common/errors/app-error';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  SaveOrganizationIdentityConfigResult,
  StoredOrganizationIdentityConfig,
} from '../application/organization-identity-config-repository.port';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  type IdentityConfigAlgorithm,
  type IdentityConfigStatus,
  parsePublicJsonWebKeySet,
} from '../domain/organization-identity-config';
import {
  identityStoreError,
  isRecord,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from './identity-row';
import {
  auditStamp,
  recordOrganizationAuditEvent,
} from './organization-audit-event.store';
import type { PostgresIdentityClient } from './postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';

const LOCK_ORGANIZATION_SQL = `
  SELECT status
  FROM organizations
  WHERE id = $1
  FOR UPDATE
`;

const LOCK_CALLER_MEMBERSHIP_SQL = `
  SELECT role, status
  FROM organization_members
  WHERE organization_id = $1
    AND user_account_id = $2
  FOR UPDATE
`;

const UPSERT_SQL = `
  INSERT INTO organization_identity_configs (
    organization_id, issuer, jwks_url, public_keys_jwks,
    allowed_algorithms, max_assertion_ttl_seconds, status
  ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active')
  ON CONFLICT (organization_id) DO UPDATE SET
    issuer = EXCLUDED.issuer,
    jwks_url = EXCLUDED.jwks_url,
    public_keys_jwks = EXCLUDED.public_keys_jwks,
    allowed_algorithms = EXCLUDED.allowed_algorithms,
    max_assertion_ttl_seconds = EXCLUDED.max_assertion_ttl_seconds,
    jwks_cache_version = organization_identity_configs.jwks_cache_version + 1
  WHERE (organization_identity_configs.issuer,
         organization_identity_configs.jwks_url,
         organization_identity_configs.public_keys_jwks,
         organization_identity_configs.allowed_algorithms,
         organization_identity_configs.max_assertion_ttl_seconds)
    IS DISTINCT FROM
        (EXCLUDED.issuer,
         EXCLUDED.jwks_url,
         EXCLUDED.public_keys_jwks,
         EXCLUDED.allowed_algorithms,
         EXCLUDED.max_assertion_ttl_seconds)
  RETURNING organization_id, issuer, jwks_url, public_keys_jwks,
            allowed_algorithms, max_assertion_ttl_seconds, status, updated_at,
            jwks_cache_version
`;

const LOOKUP_SQL = `
  SELECT
    organization_id,
    issuer,
    jwks_url,
    public_keys_jwks,
    allowed_algorithms,
    max_assertion_ttl_seconds,
    status,
    jwks_cache_version
  FROM organization_identity_configs
  WHERE organization_id = $1
    AND status = 'active'
  LIMIT 1
`;

const READ_SQL = `
  SELECT
    organization_id,
    issuer,
    jwks_url,
    public_keys_jwks,
    allowed_algorithms,
    max_assertion_ttl_seconds,
    status,
    updated_at,
    jwks_cache_version
  FROM organization_identity_configs
  WHERE organization_id = $1
  LIMIT 1
`;

function nullableStringValue(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function algorithmArrayValue(
  record: Record<string, unknown>,
  key: string,
): readonly IdentityConfigAlgorithm[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const algorithms: IdentityConfigAlgorithm[] = [];
  for (const candidate of value) {
    if (
      candidate !== IDENTITY_CONFIG_ALGORITHMS[0] &&
      candidate !== IDENTITY_CONFIG_ALGORITHMS[1]
    ) {
      return undefined;
    }
    if (algorithms.includes(candidate)) {
      return undefined;
    }
    algorithms.push(candidate);
  }

  return algorithms;
}

function statusValue(
  record: Record<string, unknown>,
  key: string,
): IdentityConfigStatus | undefined {
  const value = record[key];
  return value === 'active' || value === 'disabled' ? value : undefined;
}

function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | undefined {
  const value = record[key];
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value
    : undefined;
}

function positiveTtlValue(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 3_600
    ? value
    : undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function mapRecord(value: unknown): OrganizationIdentityConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organization_id');
  const jwksCacheVersion = stringValue(value, 'jwks_cache_version');
  const issuer = stringValue(value, 'issuer');
  const jwksUrl = nullableStringValue(value, 'jwks_url');
  const rawPublicKeys = value.public_keys_jwks;
  const publicKeysJwks =
    rawPublicKeys === null ? null : parsePublicJsonWebKeySet(rawPublicKeys);
  const allowedAlgorithms = algorithmArrayValue(value, 'allowed_algorithms');
  const maxAssertionTtlSeconds = positiveTtlValue(
    value,
    'max_assertion_ttl_seconds',
  );
  const status = statusValue(value, 'status');

  if (
    organizationId === undefined ||
    jwksCacheVersion === undefined ||
    issuer === undefined ||
    jwksUrl === undefined ||
    (jwksUrl !== null && !isHttpsUrl(jwksUrl)) ||
    publicKeysJwks === undefined ||
    (jwksUrl === null && publicKeysJwks === null) ||
    allowedAlgorithms === undefined ||
    maxAssertionTtlSeconds === undefined ||
    status === undefined
  ) {
    return undefined;
  }

  return {
    organizationId,
    jwksCacheVersion,
    issuer,
    jwksUrl,
    publicKeysJwks,
    allowedAlgorithms,
    maxAssertionTtlSeconds,
    status,
  };
}

function mapStoredRecord(
  value: unknown,
): StoredOrganizationIdentityConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config = mapRecord(value);
  const updatedAt = dateValue(value, 'updated_at');
  return config === undefined || updatedAt === undefined
    ? undefined
    : { ...config, updatedAt };
}

export class PostgresOrganizationIdentityConfigRepository
  implements OrganizationIdentityConfigRepositoryPort
{
  constructor(
    private readonly client: PostgresIdentityClient &
      PostgresIdentityTransactionalClient,
    private readonly readClient: PostgresIdentityClient = client,
  ) {}

  async findActiveByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig | null> {
    const first = await this.firstRow(LOOKUP_SQL, organizationId);
    if (first === undefined) {
      return null;
    }

    const record = mapRecord(first);
    if (record === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    return record;
  }

  async findByOrganizationId(
    organizationId: string,
  ): Promise<StoredOrganizationIdentityConfig | null> {
    const first = await this.firstRow(READ_SQL, organizationId);
    if (first === undefined) {
      return null;
    }

    const record = mapStoredRecord(first);
    if (record === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    return record;
  }

  async saveForOwner(
    input: SaveOrganizationIdentityConfigInput,
  ): Promise<SaveOrganizationIdentityConfigResult> {
    const stamp = auditStamp(input, input.userId, input.context.receivedAt);

    try {
      return await this.client.transaction(async (transaction) => {
        const organization = (
          await transaction.query(LOCK_ORGANIZATION_SQL, [input.organizationId])
        )[0];
        if (!isRecord(organization)) {
          return { kind: 'forbidden' as const };
        }
        const organizationStatus = organizationStatusValue(
          organization,
          'status',
        );
        if (organizationStatus === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        if (organizationStatus !== 'active') {
          return { kind: 'forbidden' as const };
        }

        const membership = (
          await transaction.query(LOCK_CALLER_MEMBERSHIP_SQL, [
            input.organizationId,
            input.userId,
          ])
        )[0];
        if (!isRecord(membership)) {
          return { kind: 'forbidden' as const };
        }
        const role = membershipRoleValue(membership, 'role');
        const status = membershipStatusValue(membership, 'status');
        if (role === undefined || status === undefined) {
          throw identityStoreError('Identity data is invalid');
        }
        if (role !== 'owner' || status !== 'active') {
          return { kind: 'forbidden' as const };
        }

        const values = [
          input.organizationId,
          input.issuer,
          input.jwksUrl,
          input.publicKeysJwks === null
            ? null
            : JSON.stringify(input.publicKeysJwks),
          [...input.allowedAlgorithms],
          input.maxAssertionTtlSeconds,
        ] as const;
        const writtenRows = await transaction.query(UPSERT_SQL, values);
        const changed = writtenRows.length > 0;
        const row =
          writtenRows[0] ??
          (await transaction.query(READ_SQL, [input.organizationId]))[0];
        const config = mapStoredRecord(row);
        if (config === undefined) {
          throw identityStoreError('Identity data is invalid');
        }

        if (changed) {
          await recordOrganizationAuditEvent(transaction, stamp, {
            action: 'organization.identity_config_set',
            organizationId: input.organizationId,
            issuer: input.issuer,
            sourceKind: input.sourceKind,
          });
        }

        return {
          kind: changed ? ('saved' as const) : ('unchanged' as const),
          config,
        };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (isIssuerConflict(error)) {
        throw new AppError({
          code: 'ORGANIZATION_IDENTITY_ISSUER_CONFLICT',
          message: 'Issuer is already configured for another Organization',
          retryable: false,
        });
      }
      throw identityStoreError('Identity store is unavailable');
    }
  }

  private async firstRow(
    sql: string,
    organizationId: string,
  ): Promise<unknown> {
    if (organizationId.trim().length === 0) {
      throw identityStoreError('Identity organization id is invalid');
    }

    let rows: readonly unknown[];
    try {
      rows = await this.readClient.query(sql, [organizationId]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
    return rows[0];
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
    if (this.readClient !== this.client) {
      await this.readClient.close();
    }
  }
}

function isIssuerConflict(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === '23505' &&
    error.constraint === 'oic_issuer_uq'
  );
}
