import { AppError } from '@/common/errors/app-error';
import {
  IDENTITY_CONFIG_ALGORITHMS,
  type IdentityConfigAlgorithm,
  type IdentityConfigStatus,
  parsePublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';
import type {
  OrganizationIdentityConfig,
  OrganizationIdentityConfigRepositoryPort,
  SaveOrganizationIdentityConfigInput,
  SaveOrganizationIdentityConfigResult,
  StoredOrganizationIdentityConfig,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

import {
  auditStamp,
  recordOrganizationAuditEvent,
} from '@/modules/identity/audit/infrastructure/organization-audit-event.store';
import {
  dateValue,
  identityStoreError,
  identityStoreUnavailable,
  isRecord,
  membershipRoleValue,
  membershipStatusValue,
  organizationStatusValue,
  stringValue,
} from '@/modules/identity/shared/infrastructure/identity-row';
import {
  type IdentityRepositoryClient,
  identityRows,
  identityTransaction,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

type IdentityConfigRow = Record<string, unknown>;

const ACTIVE_CONFIG_COLUMNS_SQL = `
  organization_id AS "organizationId",
  issuer,
  jwks_url AS "jwksUrl",
  public_keys_jwks AS "publicKeysJwks",
  allowed_algorithms AS "allowedAlgorithms",
  max_assertion_ttl_seconds AS "maxAssertionTtlSeconds",
  status,
  jwks_cache_version AS "jwksCacheVersion"
`;

const STORED_CONFIG_COLUMNS_SQL = `${ACTIVE_CONFIG_COLUMNS_SQL},
  updated_at AS "updatedAt"
`;

// The same columns, selected through the generated client. The upsert below
// cannot be expressed there, so its `RETURNING` list stays SQL under the same
// field names and one mapper reads both.
const ACTIVE_CONFIG_SELECT = {
  organizationId: true,
  issuer: true,
  jwksUrl: true,
  publicKeysJwks: true,
  allowedAlgorithms: true,
  maxAssertionTtlSeconds: true,
  status: true,
  jwksCacheVersion: true,
} as const;

const STORED_CONFIG_SELECT = {
  ...ACTIVE_CONFIG_SELECT,
  updatedAt: true,
} as const;

const INSERT_OR_UPDATE_CONFIG_SQL = `
  INSERT INTO organization_identity_configs (
    organization_id, issuer, jwks_url, public_keys_jwks,
    allowed_algorithms, max_assertion_ttl_seconds, status
  ) VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, 'active')
  ON CONFLICT (organization_id) DO UPDATE SET
    issuer = EXCLUDED.issuer,
    jwks_url = EXCLUDED.jwks_url,
    public_keys_jwks = EXCLUDED.public_keys_jwks,
    allowed_algorithms = EXCLUDED.allowed_algorithms,
    max_assertion_ttl_seconds = EXCLUDED.max_assertion_ttl_seconds,
    jwks_cache_version = organization_identity_configs.jwks_cache_version + 1
  WHERE (
    organization_identity_configs.issuer,
    organization_identity_configs.jwks_url,
    organization_identity_configs.public_keys_jwks,
    organization_identity_configs.allowed_algorithms,
    organization_identity_configs.max_assertion_ttl_seconds
  ) IS DISTINCT FROM (
    EXCLUDED.issuer,
    EXCLUDED.jwks_url,
    EXCLUDED.public_keys_jwks,
    EXCLUDED.allowed_algorithms,
    EXCLUDED.max_assertion_ttl_seconds
  )
  RETURNING ${STORED_CONFIG_COLUMNS_SQL}
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

/**
 * The database holds a `bigint`; the application port holds its digits. The
 * conversion happens here so no application code has to know which one it is
 * looking at, and no value is rounded on the way.
 */
function jwksCacheVersionValue(value: unknown): string | undefined {
  if (typeof value === 'bigint' && value > 0n) {
    return value.toString();
  }
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? value
    : undefined;
}

function algorithmArrayValue(
  record: Record<string, unknown>,
  key: string,
): readonly IdentityConfigAlgorithm[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const candidates: readonly unknown[] = value;
  const algorithms: IdentityConfigAlgorithm[] = [];
  for (const candidate of candidates) {
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
  return config === undefined || updatedAt == null
    ? undefined
    : { ...config, updatedAt };
}

export class PostgresOrganizationIdentityConfigRepository
  implements OrganizationIdentityConfigRepositoryPort
{
  constructor(
    private readonly client: IdentityRepositoryClient,
    private readonly readClient: IdentityRepositoryClient = client,
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
      return await identityTransaction(this.client, async (transaction) => {
        const organization = (
          (await identityRows(
            transaction,
            `SELECT status FROM organizations WHERE id = $1 FOR UPDATE`,
            [input.organizationId],
          )) as readonly IdentityConfigRow[]
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
          (await identityRows(
            transaction,
            `SELECT role, status
             FROM organization_members
             WHERE organization_id = $1 AND user_account_id = $2
             FOR UPDATE`,
            [input.organizationId, input.userId],
          )) as readonly IdentityConfigRow[]
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

        const written = (await identityRows(
          transaction,
          INSERT_OR_UPDATE_CONFIG_SQL,
          [
            input.organizationId,
            input.issuer,
            input.jwksUrl,
            input.publicKeysJwks === null
              ? null
              : JSON.stringify(input.publicKeysJwks),
            [...input.allowedAlgorithms],
            input.maxAssertionTtlSeconds,
          ],
        )) as readonly IdentityConfigRow[];

        const changed = written.length > 0;
        const row =
          written[0] ??
          (await transaction.organizationIdentityConfig.findUnique({
            where: { organizationId: input.organizationId },
            select: STORED_CONFIG_SELECT,
          })) ??
          undefined;
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
      throw identityStoreUnavailable(error);
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
      const first = await this.readClient.organizationIdentityConfig.findFirst({
        where:
          status === null ? { organizationId } : { organizationId, status },
        select: status === null ? STORED_CONFIG_SELECT : ACTIVE_CONFIG_SELECT,
      });
      return first ?? undefined;
    } catch (error) {
      throw identityStoreUnavailable(error);
    }
  }
}

/**
 * Prisma wraps PostgreSQL uniqueness failures with the SQLSTATE and detail in
 * its metadata. Only those fields are inspected; query text and values stay
 * inside the error boundary.
 */
function isIssuerConflict(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const pending = [error];
  const seen = new Set<Record<string, unknown>>();
  while (pending.length > 0) {
    const failure = pending.pop();
    if (!isRecord(failure) || seen.has(failure)) {
      continue;
    }
    seen.add(failure);

    const constraint = failure.constraint;
    const constraintName =
      typeof constraint === 'string'
        ? constraint
        : isRecord(constraint) && typeof constraint.index === 'string'
          ? constraint.index
          : undefined;
    if (
      (failure.code === '23505' &&
        (constraintName === 'oic_issuer_uq' ||
          (typeof failure.message === 'string' &&
            failure.message.includes('oic_issuer_uq')))) ||
      (failure.kind === 'UniqueConstraintViolation' &&
        constraintName === 'oic_issuer_uq')
    ) {
      return true;
    }

    for (const key of ['cause', 'meta', 'driverAdapterError']) {
      const nested = failure[key];
      if (isRecord(nested)) {
        pending.push(nested);
      }
    }
  }
  return false;
}
