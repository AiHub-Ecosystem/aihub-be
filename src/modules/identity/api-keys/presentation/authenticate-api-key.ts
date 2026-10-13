import { AppError } from '@/common/errors/app-error';
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import {
  type RequestEnvironmentConfig,
  resolveAihubEnvironment,
} from '@/modules/identity/shared/presentation/request-environment';

export function forbidden(): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: 'API key is not authorized for this operation',
    retryable: false,
  });
}

export interface AuthenticateApiKeyOptions {
  /** Use when the route must observe revocation and policy changes immediately. */
  readonly forceFresh?: boolean;
  /** Trusted only after a server-to-server BFF guard has authenticated the caller. */
  readonly clientIp?: string;
}

/**
 * Turns the `X-API-Key` header into an authenticated identity and attaches it
 * to the request.
 *
 * Shared by every guard that authenticates a key, so that the environment
 * binding, the missing-header case, and the client address the brute-force
 * counter keys on are decided in one place. A second guard that reimplemented
 * this would be free to drift into authenticating slightly differently, which
 * is the kind of difference nobody notices until it matters.
 */
export async function authenticateApiKey(
  request: AuthenticatedRequest,
  authenticator: ApiKeyAuthenticatorPort,
  configuration: RequestEnvironmentConfig,
  options: AuthenticateApiKeyOptions = {},
): Promise<AuthenticatedApiKey> {
  const environment = resolveAihubEnvironment(request, configuration);
  const rawHeader = request.headers['x-api-key'];
  const value = typeof rawHeader === 'string' ? rawHeader : '';
  const authenticated = await authenticator.authenticate({
    value,
    environment,
    clientIp:
      options.clientIp ?? (request.ip.length === 0 ? 'unknown' : request.ip),
    ...(options.forceFresh === true ? { forceFresh: true } : {}),
  });

  request.aihubAuth = authenticated;
  return authenticated;
}
