import { and, eq, sql } from 'drizzle-orm';

import { AppError } from '@/common/errors/app-error';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  SaveOrganizationIdentityConfigResult,
  StoredOrganizationIdentityConfig,
} from '@/modules/identity/application/organization-identity-config-repository.port';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  type IdentityConfigAlgorithm,
  type IdentityConfigStatus,
  parsePublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';

import { organizationIdentityConfigs } from './drizzle-identity-schema';
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
import type { IdentityDrizzleClient } from './postgres-identity.client';

/**
 * Columns are named rather than defaulted. The read replica holds a column-level
 * grant, so a `select *` would ask it for `created_at` as well, which it does
 * not have.
 */
const ACTIVE_CONFIG_COLUMNS = {
  organizationId: organizationIdentityConfigs.organizationId,
  issuer: organizationIdentityConfigs.issuer,
  jwksUrl: organizationIdentityConfigs.jwksUrl,
  publicKeysJwks: organizationIdentityConfigs.publicKeysJwks,
  allowedAlgorithms: organizationIdentityConfigs.allowedAlgorithms,
  maxAssertionTtlSeconds: organizationIdentityConfigs.maxAssertionTtlSeconds,
  status: organizationIdentityConfigs.status,
  jwksCacheVersion: organizationIdentityConfigs.jwksCacheVersion,
};

const STORED_CONFIG_COLUMNS = {
  ...ACTIVE_CONFIG_COLUMNS,
  updatedAt: organizationIdentityConfigs.updatedAt,
};

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

/**
 * The database holds a `bigint`; the application port holds its digits. The
 * conversion happens here so no application code has to know which one it is
 * looking at, and no value is rounded on the way.
 */
function jwksCacheVersionValue(value: unknown): string | undefined {
  return typeof value === 'bigint' && value > 0n ? value.toString() : undefined;
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

export function identityConfigFromRow(
  value: unknown,
): OrganizationIdentityConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organizationId');
  const jwksCacheVersion = jwksCacheVersionValue(value.jwksCacheVersion);
  const issuer = stringValue(value, 'issuer');
  const jwksUrl = nullableStringValue(value, 'jwksUrl');
  const rawPublicKeys = value.publicKeysJwks;
  const publicKeysJwks =
    rawPublicKeys === null ? null : parsePublicJsonWebKeySet(rawPublicKeys);
  const allowedAlgorithms = algorithmArrayValue(value, 'allowedAlgorithms');
  const maxAssertionTtlSeconds = positiveTtlValue(
    value,
    'maxAssertionTtlSeconds',
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

export function storedIdentityConfigFromRow(
  value: unknown,
): StoredOrganizationIdentityConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config = identityConfigFromRow(value);
  const updatedAt = dateValue(value, 'updatedAt');
  return config === undefined || updatedAt === undefined
    ? undefined
    : { ...config, updatedAt };
}

export class PostgresOrganizationIdentityConfigRepository
  implements OrganizationIdentityConfigRepositoryPort
{
  constructor(
    private readonly client: IdentityDrizzleClient,
    private readonly readClient: IdentityDrizzleClient = client,
  ) {}

  async findActiveByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig | null> {
    const first = await this.firstRow(organizationId, 'active');
    if (first === undefined) {
      return null;
    }

    const record = identityConfigFromRow(first);
    if (record === undefined) {
      throw identityStoreError('Identity data is invalid');
    }

    return record;
  }

  async findByOrganizationId(
    organizationId: string,
  ): Promise<StoredOrganizationIdentityConfig | null> {
    const first = await this.firstRow(organizationId, null);
    if (first === undefined) {
      return null;
    }

    const record = storedIdentityConfigFromRow(first);
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
          await transaction.db.execute<Record<string, unknown>>(sql`
            SELECT status
            FROM organizations
            WHERE id = ${input.organizationId}
            FOR UPDATE
          `)
        ).rows[0];
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
          await transaction.db.execute<Record<string, unknown>>(sql`
            SELECT role, status
            FROM organization_members
            WHERE organization_id = ${input.organizationId}
              AND user_account_id = ${input.userId}
            FOR UPDATE
          `)
        ).rows[0];
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

        const written = await transaction.db
          .insert(organizationIdentityConfigs)
          .values({
            organizationId: input.organizationId,
            issuer: input.issuer,
            jwksUrl: input.jwksUrl,
            publicKeysJwks: input.publicKeysJwks,
            allowedAlgorithms: [...input.allowedAlgorithms],
            maxAssertionTtlSeconds: input.maxAssertionTtlSeconds,
            status: 'active',
          })
          .onConflictDoUpdate({
            target: organizationIdentityConfigs.organizationId,
            set: {
              issuer: input.issuer,
              jwksUrl: input.jwksUrl,
              publicKeysJwks: input.publicKeysJwks,
              allowedAlgorithms: [...input.allowedAlgorithms],
              maxAssertionTtlSeconds: input.maxAssertionTtlSeconds,
              jwksCacheVersion: sql`${organizationIdentityConfigs.jwksCacheVersion} + 1`,
            },
            /**
             * The conflict update is what makes a repeated identical save a
             * no-op: with nothing different to write, the statement updates no
             * row, returns none, and the caller reads the stored row back
             * without bumping the JWKS cache version or writing an audit event.
             */
            setWhere: sql`(${organizationIdentityConfigs.issuer}, ${organizationIdentityConfigs.jwksUrl}, ${organizationIdentityConfigs.publicKeysJwks}, ${organizationIdentityConfigs.allowedAlgorithms}, ${organizationIdentityConfigs.maxAssertionTtlSeconds}) is distinct from (excluded.issuer, excluded.jwks_url, excluded.public_keys_jwks, excluded.allowed_algorithms, excluded.max_assertion_ttl_seconds)`,
          })
          .returning(STORED_CONFIG_COLUMNS);

        const changed = written.length > 0;
        const row =
          written[0] ??
          (
            await transaction.db
              .select(STORED_CONFIG_COLUMNS)
              .from(organizationIdentityConfigs)
              .where(
                eq(
                  organizationIdentityConfigs.organizationId,
                  input.organizationId,
                ),
              )
              .limit(1)
          )[0];
        const config = storedIdentityConfigFromRow(row);
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
    organizationId: string,
    status: IdentityConfigStatus | null,
  ) {
    if (organizationId.trim().length === 0) {
      throw identityStoreError('Identity organization id is invalid');
    }

    try {
      const [first] = await this.readClient.db
        .select(status === null ? STORED_CONFIG_COLUMNS : ACTIVE_CONFIG_COLUMNS)
        .from(organizationIdentityConfigs)
        .where(
          and(
            eq(organizationIdentityConfigs.organizationId, organizationId),
            status === null
              ? undefined
              : eq(organizationIdentityConfigs.status, status),
          ),
        )
        .limit(1);
      return first;
    } catch {
      throw identityStoreError('Identity store is unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
    if (this.readClient !== this.client) {
      await this.readClient.close();
    }
  }
}

/**
 * Drizzle carries a driver failure in `cause`, so the PostgreSQL code and
 * constraint this maps on are one level down from the error the transaction
 * rejects with. Only those two fields are read; the statement and its
 * parameters that Drizzle also puts on the wrapper never leave this check.
 */
function isIssuerConflict(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const failure = isRecord(error.cause) ? error.cause : error;
  return failure.code === '23505' && failure.constraint === 'oic_issuer_uq';
}
