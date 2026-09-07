export interface ApiKeyCredential {
  readonly value: string;
  readonly environment: string;
}

export interface AuthenticatedApiKey {
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly environment: string;
  readonly scopes: readonly string[];
}

export interface ApiKeyAuthenticatorPort {
  authenticate(credentials: ApiKeyCredential): Promise<AuthenticatedApiKey>;
}

export const API_KEY_AUTHENTICATOR = Symbol('API_KEY_AUTHENTICATOR');
