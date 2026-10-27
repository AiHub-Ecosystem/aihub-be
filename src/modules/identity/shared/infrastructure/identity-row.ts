import { AppError } from '@/common/errors/app-error';
import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import { asDateOrIso } from '@/common/postgres/row-readers';
import type { OrganizationStatus } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';

/**
 * Row readers for the identity repositories. The generic ones live in
 * `@/common/postgres/row-readers`, shared with Auth and Metering, and are
 * re-exported here so every identity repository imports one module.
 */

/** Identity data that broke an invariant: never retryable. */
export function identityStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

/**
 * A failed identity-store call. A Postgres that could not be reached or
 * stopped answering is a retryable outage (ADR-0118); anything else stays an
 * internal error.
 */
export function identityStoreUnavailable(cause: unknown): AppError {
  if (isPostgresUnavailable(cause)) return databaseUnavailableError(cause);
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Identity store is unavailable',
    retryable: false,
    cause,
  });
}

export {
  booleanValue,
  nullableNonNegativeIntegerValue,
  nullableStringValue,
  oneOf,
  positiveIntegerValue,
  stringArrayValue,
  stringValue,
} from '@/common/postgres/row-readers';

export function membershipRoleValue(
  record: Record<string, unknown>,
  key: string,
): OrganizationMembershipRole | undefined {
  const value = record[key];
  return value === 'owner' || value === 'admin' || value === 'member'
    ? value
    : undefined;
}

export function membershipStatusValue(
  record: Record<string, unknown>,
  key: string,
): OrganizationMembershipStatus | undefined {
  const value = record[key];
  return value === 'active' || value === 'disabled' ? value : undefined;
}

export function organizationStatusValue(
  record: Record<string, unknown>,
  key: string,
): OrganizationStatus | undefined {
  const value = record[key];
  return value === 'active' || value === 'suspended' ? value : undefined;
}

/**
 * A timestamp column that may be NULL and may arrive as text: `null` only for
 * SQL NULL, a `Date` copy otherwise, `undefined` for anything malformed.
 */
export function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  return record[key] === null ? null : asDateOrIso(record[key]);
}
