import { AppError } from './app-error';

/**
 * The rejection for a user-scoped operation that reaches AIHUB without an
 * End-User ID. Raised by the identity guard and re-checked by the grading
 * controllers and the Speaking adapter, which sit in different modules, so the
 * one definition lives here.
 */
export function userIdentityRequired(): AppError {
  return new AppError({
    code: 'USER_IDENTITY_REQUIRED',
    message: 'User identity is required in X-User-Identity',
    retryable: false,
  });
}
