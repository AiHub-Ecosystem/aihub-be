import { AppError } from '@/common/errors/app-error';

export function invalidRefreshToken(): AppError {
  return new AppError({
    code: 'AUTH_REFRESH_TOKEN_INVALID',
    message: 'Refresh token is invalid',
    retryable: false,
  });
}

export function invalidPasswordResetToken(): AppError {
  return new AppError({
    code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
    message: 'Password reset token is invalid',
    retryable: false,
  });
}

export function invalidUserAccessToken(): AppError {
  return new AppError({
    code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
    message: 'User access token is invalid',
    retryable: false,
  });
}

export function invalidVerificationToken(): AppError {
  return new AppError({
    code: 'AUTH_VERIFICATION_TOKEN_INVALID',
    message: 'Verification token is invalid',
    retryable: false,
  });
}

export function invalidCredentials(): AppError {
  return new AppError({
    code: 'AUTH_CREDENTIALS_INVALID',
    message: 'Email or password is invalid',
    retryable: false,
  });
}
