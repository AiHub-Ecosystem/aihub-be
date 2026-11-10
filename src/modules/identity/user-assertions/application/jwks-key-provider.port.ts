import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

export interface JwksKeyProviderInput {
  readonly organizationId: string;
  readonly config: OrganizationIdentityConfig;
  readonly forceRefresh?: boolean;
}

export interface JwksKeyProviderPort {
  resolve(input: JwksKeyProviderInput): Promise<PublicJsonWebKeySet>;
  /**
   * Fetches and caches the JWKS at the URL, and returns the key set it
   * validated so the caller can record which keys it trusted (#447).
   */
  validateRemote(input: {
    readonly organizationId: string;
    readonly url: string;
  }): Promise<PublicJsonWebKeySet>;
}

export const JWKS_KEY_PROVIDER = Symbol('JWKS_KEY_PROVIDER');
