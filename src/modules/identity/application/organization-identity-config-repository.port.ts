import type {
  IdentityConfigAlgorithm,
  IdentityConfigStatus,
  PublicJsonWebKeySet,
} from '../domain/organization-identity-config';

export type {
  IdentityConfigAlgorithm,
  IdentityConfigStatus,
  PublicJsonWebKeySet,
};

export interface OrganizationIdentityConfig {
  readonly organizationId: string;
  readonly issuer: string;
  readonly jwksUrl: string | null;
  readonly publicKeysJwks: PublicJsonWebKeySet | null;
  readonly allowedAlgorithms: readonly IdentityConfigAlgorithm[];
  readonly maxAssertionTtlSeconds: number;
  readonly status: IdentityConfigStatus;
}

export interface StoredOrganizationIdentityConfig
  extends OrganizationIdentityConfig {
  readonly updatedAt: Date;
}

export interface OrganizationIdentityConfigRepositoryPort {
  findActiveByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig | null>;
  findByOrganizationId(
    organizationId: string,
  ): Promise<StoredOrganizationIdentityConfig | null>;
}

export const ORGANIZATION_IDENTITY_CONFIG_REPOSITORY = Symbol(
  'ORGANIZATION_IDENTITY_CONFIG_REPOSITORY',
);
