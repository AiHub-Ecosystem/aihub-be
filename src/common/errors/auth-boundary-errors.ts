import { AppError } from './app-error';

export function authenticatedUserContextMissing(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authenticated user context is missing',
    retryable: false,
  });
}

export function authenticationConfigurationInvalid(options?: {
  readonly diagnostic?: string;
  readonly cause?: unknown;
}): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
    ...(options?.diagnostic === undefined
      ? {}
      : { diagnostic: options.diagnostic }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function clientSecretMissingOrInvalid(): AppError {
  return new AppError({
    code: 'UNAUTHORIZED',
    message: 'Client secret is missing or invalid',
    retryable: false,
  });
}
