import { AppError } from '../../../common/errors/app-error';
import type {
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  ApiKeyStatus,
  OrganizationStatus,
} from '../application/api-key-authenticator.port';

export interface PostgresIdentityClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

const LOOKUP_SQL = `
  SELECT
    ak.organization_id,
    ak.id AS api_key_id,
    org.status AS organization_status,
    ak.status AS api_key_status,
    ak.scopes,
    org.entitlements,
    ak.allowed_environments,
    ak.expires_at,
    org.rate_limit_rpm,
    org.max_concurrent,
    org.monthly_request_quota,
    org.hard_stop_on_quota
  FROM api_keys AS ak
  INNER JOIN organizations AS org ON org.id = ak.organization_id
  WHERE ak.key_hash = decode($1, 'hex')
  LIMIT 1
`;

const LAST_USED_SQL = `
  UPDATE api_keys
  SET last_used_at = $2
  WHERE id = $1
    AND (last_used_at IS NULL OR last_used_at < $2 - interval '1 minute')
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

function stringArrayValue(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function statusValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = record[key];
  return typeof value === 'string'
    ? allowed.find((candidate) => candidate === value)
    : undefined;
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

function positiveIntegerValue(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function quotaValue(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function booleanValue(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function mapRecord(value: unknown): ApiKeyRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organization_id');
  const apiKeyId = stringValue(value, 'api_key_id');
  const organizationStatus = statusValue<OrganizationStatus>(
    value,
    'organization_status',
    ['active', 'suspended'],
  );
  const status = statusValue<ApiKeyStatus>(value, 'api_key_status', [
    'active',
    'revoked',
  ]);
  const scopes = stringArrayValue(value, 'scopes');
  const entitlements = stringArrayValue(value, 'entitlements');
  const allowedEnvironments = stringArrayValue(value, 'allowed_environments');
  const expiresAt = dateValue(value, 'expires_at');
  const rateLimitRpm = positiveIntegerValue(value, 'rate_limit_rpm');
  const maxConcurrent = positiveIntegerValue(value, 'max_concurrent');
  const monthlyRequestQuota = quotaValue(value, 'monthly_request_quota');
  const hardStopOnQuota = booleanValue(value, 'hard_stop_on_quota');

  if (
    organizationId === undefined ||
    apiKeyId === undefined ||
    organizationStatus === undefined ||
    status === undefined ||
    scopes === undefined ||
    entitlements === undefined ||
    allowedEnvironments === undefined ||
    expiresAt === undefined ||
    rateLimitRpm === undefined ||
    maxConcurrent === undefined ||
    monthlyRequestQuota === undefined ||
    hardStopOnQuota === undefined
  ) {
    return undefined;
  }

  return {
    organizationId,
    apiKeyId,
    organizationStatus,
    status,
    scopes,
    entitlements,
    allowedEnvironments,
    expiresAt,
    rateLimitRpm,
    maxConcurrent,
    monthlyRequestQuota,
    hardStopOnQuota,
  };
}

export class PostgresApiKeyRepository implements ApiKeyRepositoryPort {
  constructor(private readonly client: PostgresIdentityClient) {}

  async findByHash(hashHex: string): Promise<ApiKeyRecord | null> {
    if (!/^[0-9a-f]{64}$/.test(hashHex)) {
      throw identityStoreError('Identity lookup hash is invalid');
    }

    let rows: readonly unknown[];
    try {
      rows = await this.client.query(LOOKUP_SQL, [hashHex]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }

    const first = rows[0];
    if (first === undefined) {
      return null;
    }

    const record = mapRecord(first);
    if (record === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    return record;
  }

  async touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void> {
    try {
      await this.client.query(LAST_USED_SQL, [apiKeyId, usedAt]);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
