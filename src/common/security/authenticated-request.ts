import { AppError } from '@/common/errors/app-error';

/**
 * Reads the authenticated API key from a request augmented by Identity.
 * Generic on purpose: a cross-cutting primitive may not import a type owned
 * by a business module (ADR-0061).
 */
export function getAuthenticatedApiKey<T>(request: {
  readonly aihubAuth?: T;
}): T {
  const authenticated = request.aihubAuth;
  if (authenticated === undefined) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      message: 'Authentication is required',
      retryable: false,
    });
  }
  return authenticated;
}
