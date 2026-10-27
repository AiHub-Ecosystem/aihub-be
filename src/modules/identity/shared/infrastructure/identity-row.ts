import { AppError } from '@/common/errors/app-error';
import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import type { OrganizationStatus } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';

/**
 * Shared row readers for the identity repositories. Every durable value that
 * reaches the application crosses one of these, so a column that is missing,
 * null, or outside its vocabulary fails loudly instead of flowing onward as an
 * unchecked cast.
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

export function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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

export function dateValue(
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
