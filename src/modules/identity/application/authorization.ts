import type { AuthenticatedApiKey } from './api-key-authenticator.port';

export function hasRequiredScope(
  apiKey: AuthenticatedApiKey,
  requiredScope: string,
): boolean {
  return apiKey.scopes.includes(requiredScope);
}
