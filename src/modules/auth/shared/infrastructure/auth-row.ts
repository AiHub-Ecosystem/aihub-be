import { AppError } from '@/common/errors/app-error';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';

const ACCOUNT_STATUSES = [
  'pending_verification',
  'active',
  'disabled',
] as const satisfies readonly LocalAccountStatus[];

/**
 * Row readers for the auth repositories. The generic ones live in
 * `@/common/postgres/row-readers`, shared with Identity and Metering, and are
 * re-exported here so every auth repository imports one module.
 */

export function authStoreError(message: string): AppError {
  return new AppError({ code: 'INTERNAL_ERROR', message, retryable: false });
}

export {
  dateValue,
  integerValue,
  nullableDateValue,
  nullableOneOf,
  nullableStringValue,
  oneOf,
  stringValue,
} from '@/common/postgres/row-readers';

/**
 * The User Account status a row reports, read against the one vocabulary the
 * domain declares. A projection carrying anything else fails here instead of
 * widening into an unchecked cast.
 */
export function isAccountStatus(status: unknown): status is LocalAccountStatus {
  return ACCOUNT_STATUSES.some((entry) => entry === status);
}
