import { AppError } from '../../../common/errors/app-error';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
  StoredOrganizationIdentityConfig,
} from '../application/organization-identity-config-repository.port';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  type IdentityConfigAlgorithm,
  type IdentityConfigStatus,
  parsePublicJsonWebKeySet,
} from '../domain/organization-identity-config';
import type { PostgresIdentityClient } from './postgres-api-key.repository';

const LOOKUP_SQL = `
  SELECT
    organization_id,
    issuer,
    jwks_url,
    public_keys_jwks,
    allowed_algorithms,
    max_assertion_ttl_seconds,
    status
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
    updated_at
  FROM organization_identity_configs
  WHERE organization_id = $1
  LIMIT 1
`;

function identityStoreError(message: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message,
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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
  constructor(private readonly client: PostgresIdentityClient) {}

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

  private async firstRow(
    sql: string,
    organizationId: string,
  ): Promise<unknown> {
    if (organizationId.trim().length === 0) {
      throw identityStoreError('Identity organization id is invalid');
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(sql, [organizationId]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
    return rows[0];
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
