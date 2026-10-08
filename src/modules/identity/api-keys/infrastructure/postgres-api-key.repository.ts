import { and, eq, isNull, lt, or } from 'drizzle-orm';

import type {
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  DurableApiKeyStatus,
  OrganizationStatus,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';

import {
  apiKeys,
  organizations,
} from '@/modules/identity/shared/infrastructure/drizzle-identity-schema';
import {
  identityStoreError,
  isRecord,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import type { IdentityDatabaseClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

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
    expiresAt,
    rateLimitRpm,
    maxConcurrent,
    monthlyRequestQuota,
    hardStopOnQuota,
  };
}

export class PostgresApiKeyRepository implements ApiKeyRepositoryPort {
  constructor(private readonly client: IdentityDatabaseClient) {}

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
      return await this.client.db
        .select({
          organizationId: apiKeys.organizationId,
          apiKeyId: apiKeys.id,
          organizationStatus: organizations.status,
          status: apiKeys.status,
          scopes: apiKeys.scopes,
          entitlements: organizations.entitlements,
          allowedEnvironments: apiKeys.allowedEnvironments,
          expiresAt: apiKeys.expiresAt,
          rateLimitRpm: organizations.rateLimitRpm,
          maxConcurrent: organizations.maxConcurrent,
          monthlyRequestQuota: organizations.monthlyRequestQuota,
          hardStopOnQuota: organizations.hardStopOnQuota,
        })
        .from(apiKeys)
        .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
        .where(eq(apiKeys.keyHash, Buffer.from(hashHex, 'hex')))
        .limit(1);
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void> {
    try {
      await this.client.db
        .update(apiKeys)
        .set({ lastUsedAt: usedAt })
        .where(
          and(
            eq(apiKeys.id, apiKeyId),
            or(
              isNull(apiKeys.lastUsedAt),
              lt(
                apiKeys.lastUsedAt,
                new Date(usedAt.getTime() - LAST_USED_THROTTLE_MS),
              ),
            ),
          ),
        );
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }
}
