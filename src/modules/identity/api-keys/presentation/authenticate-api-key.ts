import { AppError } from '@/common/errors/app-error';
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { hashApiKey } from '@/modules/identity/domain/api-key';
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
  /** Requires the stored environment binding to match this set exactly. */
  readonly requiredAllowedEnvironments?: readonly string[];
  /**
   * Also keys the brute-force counter on the presented credential. The public
   * demo needs it because every visitor behind the Customer Web BFF presents
   * from one shared egress address, so an address-scoped counter alone would let
   * one visitor's failures lock out all the others.
   */
  readonly scopeFailuresByKey?: boolean;
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
    clientIp: request.ip.length === 0 ? 'unknown' : request.ip,
    ...(options.requiredAllowedEnvironments === undefined
      ? {}
      : { requiredAllowedEnvironments: options.requiredAllowedEnvironments }),
    ...(options.scopeFailuresByKey === true
      ? { additionalAbuseScopes: [`key:${hashApiKey(value)}`] }
      : {}),
  });

  request.aihubAuth = authenticated;
  return authenticated;
}
