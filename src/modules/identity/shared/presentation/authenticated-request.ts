import { AppError } from '@/common/errors/app-error';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { ResolvedUserIdentity } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';

declare module 'fastify' {
  interface FastifyRequest {
    aihubAuth?: AuthenticatedApiKey;
    aihubIdentity?: ResolvedUserIdentity;
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
      retryable: false,
    });
  }

  return request.aihubAuth;
}
