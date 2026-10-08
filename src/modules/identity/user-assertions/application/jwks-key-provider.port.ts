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
  validateRemote(input: {
    readonly organizationId: string;
    readonly url: string;
  }): Promise<void>;
}

export const JWKS_KEY_PROVIDER = Symbol('JWKS_KEY_PROVIDER');
