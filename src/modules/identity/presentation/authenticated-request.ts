import { AppError } from '../../../common/errors/app-error';
import type { AuthenticatedApiKey } from '../application/api-key-authenticator.port';

declare module 'fastify' {
  interface FastifyRequest {
    aihubAuth?: AuthenticatedApiKey;
  }
}

export type AuthenticatedRequest = import('fastify').FastifyRequest;

export function getAuthenticatedApiKey(
  request: AuthenticatedRequest,
): AuthenticatedApiKey {
  if (request.aihubAuth === undefined) {
    throw new AppError({
      code: 'UNAUTHORIZED',
      message: 'Authentication is required',
      httpStatus: 401,
      retryable: false,
    });
  }

  return request.aihubAuth;
}
