import type {
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  DurableApiKeyStatus,
  OrganizationStatus,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';

import {
  dateValue,
  identityStoreError,
  isRecord,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

type ApiKeyLookupRow = Record<string, unknown>;

export const API_KEY_LOOKUP_SQL = `
  SELECT
    api_key.organization_id AS "organizationId",
    api_key.id AS "apiKeyId",
    organization.status AS "organizationStatus",
    api_key.status AS status,
    api_key.scopes AS scopes,
    organization.entitlements AS entitlements,
    api_key.allowed_environments AS "allowedEnvironments",
    api_key.expires_at AS "expiresAt",
    organization.rate_limit_rpm AS "rateLimitRpm",
    organization.max_concurrent AS "maxConcurrent",
    organization.monthly_request_quota AS "monthlyRequestQuota",
    organization.hard_stop_on_quota AS "hardStopOnQuota"
  FROM api_keys AS api_key
  INNER JOIN organizations AS organization
    ON organization.id = api_key.organization_id
  WHERE api_key.key_hash = $1
  LIMIT 1
`;

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

/**
 * Last-used telemetry is best-effort, so it is written at most once per window.
 * The cutoff is the caller's own instant less this window, which is what the
 * statement compared against before.
 */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * The row a lookup returns is whatever PostgreSQL and the driver produced, so
 * every durable value is still read through a check rather than trusted. The
 * projection names match these keys, which is the only thing the two share.
 */
export function apiKeyRecordFromRow(value: unknown): ApiKeyRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organizationId');
  const apiKeyId = stringValue(value, 'apiKeyId');
  const organizationStatus = statusValue<OrganizationStatus>(
    value,
    'organizationStatus',
    ['active', 'suspended'],
  );
  const status = statusValue<DurableApiKeyStatus>(value, 'status', [
    'active',
    'revoked',
  ]);
  const scopes = stringArrayValue(value, 'scopes');
  const entitlements = stringArrayValue(value, 'entitlements');
  const allowedEnvironments = stringArrayValue(value, 'allowedEnvironments');
  const expiresAt = dateValue(value, 'expiresAt');
  const rateLimitRpm = positiveIntegerValue(value, 'rateLimitRpm');
  const maxConcurrent = positiveIntegerValue(value, 'maxConcurrent');
  const monthlyRequestQuota = quotaValue(value, 'monthlyRequestQuota');
  const hardStopOnQuota = booleanValue(value, 'hardStopOnQuota');

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
    expiresAt: expiresAt ?? null,
    rateLimitRpm,
    maxConcurrent,
    monthlyRequestQuota,
    hardStopOnQuota,
  };
}

export class PostgresApiKeyRepository implements ApiKeyRepositoryPort {
  constructor(private readonly client: IdentityRepositoryClient) {}

  async findByHash(hashHex: string): Promise<ApiKeyRecord | null> {
    if (!/^[0-9a-f]{64}$/.test(hashHex)) {
      throw identityStoreError('Identity lookup hash is invalid');
    }

    const [first] = await this.lookup(hashHex);
    if (first === undefined) {
      return null;
    }

    const record = apiKeyRecordFromRow(first);
    if (record === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    return record;
  }

  private async lookup(hashHex: string) {
    try {
      return (await identityRows(this.client, API_KEY_LOOKUP_SQL, [
        Buffer.from(hashHex, 'hex'),
      ])) as readonly ApiKeyLookupRow[];
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void> {
    try {
      const throttleCutoff = new Date(usedAt.getTime() - LAST_USED_THROTTLE_MS);
      await this.client.apiKey.updateMany({
        where: {
          id: apiKeyId,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: throttleCutoff } }],
        },
        data: { lastUsedAt: usedAt },
      });
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }
}
