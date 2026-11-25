import { AppError } from '@/common/errors/app-error';

/**
 * The single rule for an End-User ID, whichever form of User Identity it came
 * from: a Declared User ID as sent, or a Signed User Assertion's `sub`.
 *
 * Visible ASCII only (0x21-0x7E), so the value cannot break a log line, a
 * header, or a downstream form field. It is compared exactly as sent: AIHUB
 * never case-folds or normalizes it (ADR-0053).
 */
const END_USER_ID_MAX_LENGTH = 256;

const VISIBLE_ASCII = /^[\x21-\x7E]+$/;

export function isEndUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= END_USER_ID_MAX_LENGTH &&
    VISIBLE_ASCII.test(value)
  );
}

/** Declared mode: the value breaks the End-User ID rule. */
export function invalidDeclaredUserId(): AppError {
  return new AppError({
    code: 'INVALID_USER_IDENTITY',
    message:
      'User identity must be 1-256 visible ASCII characters with no spaces',
    retryable: false,
  });
}
