import { AppError } from '@/common/errors/app-error';
import type { OrganizationStatus } from '@/modules/identity/application/api-key-authenticator.port';
import type {
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
} from '@/modules/identity/application/organization-membership.port';

/**
 * Shared row readers for the identity repositories. Every durable value that
 * reaches the application crosses one of these, so a column that is missing,
 * null, or outside its vocabulary fails loudly instead of flowing onward as an
 * unchecked cast.
 */

export function identityStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
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
