import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { ResolvedUserIdentity } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';

declare module 'fastify' {
  interface FastifyRequest {
    aihubAuth?: AuthenticatedApiKey;
    aihubIdentity?: ResolvedUserIdentity;
  }
}

export type AuthenticatedRequest = import('fastify').FastifyRequest;

export { getAuthenticatedApiKey } from '@/common/security/authenticated-request';
