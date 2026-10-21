import { AppError } from '@/common/errors/app-error';
import { isPostgresUnavailable } from '@/common/postgres/postgres-unavailable-error';
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

/**
 * A failed identity-store call. When the cause shows Postgres could not be
 * reached or stopped answering, the caller gets a retryable outage (ADR-0118)
 * instead of an internal error.
 */
export function identityStoreError(message: string, cause?: unknown): AppError {
  if (cause !== undefined && isPostgresUnavailable(cause)) {
    return new AppError({
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database temporarily unavailable',
      retryable: true,
      retryAfterMs: 1_000,
      retryAfterHeader: true,
      cause,
    });
  }
  return new AppError({
    code: 'INTERNAL_ERROR',
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
