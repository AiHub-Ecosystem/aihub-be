import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from './organization-identity-config-repository.port';

export interface JwksKeyProviderInput {
  readonly organizationId: string;
  readonly config: OrganizationIdentityConfig;
  readonly forceRefresh?: boolean;
}

export interface JwksKeyProviderPort {
  resolve(input: JwksKeyProviderInput): Promise<PublicJsonWebKeySet>;
}

export const JWKS_KEY_PROVIDER = Symbol('JWKS_KEY_PROVIDER');
