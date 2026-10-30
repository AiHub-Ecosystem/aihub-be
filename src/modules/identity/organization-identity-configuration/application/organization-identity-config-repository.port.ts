import type { RequestContext } from '@/common/request-context/request-context';
import type {
  IdentityConfigAlgorithm,
  IdentityConfigStatus,
  PublicJsonWebKeySet,
} from '@/modules/identity/domain/organization-identity-config';

export type {
  IdentityConfigAlgorithm,
  IdentityConfigStatus,
  PublicJsonWebKeySet,
};

export interface OrganizationIdentityConfig {
  readonly organizationId: string;
  readonly jwksCacheVersion?: string;
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
  /**
   * Digits of the row's revision: it rises by one each time a write changes the
   * configuration, whoever makes it, so a later write can name the state it was
   * based on (ADR-0132). The public `ETag` is built from it.
   */
  readonly revision: string;
}

/**
 * What a write says about the state it replaces. Absent means the write is not
 * conditional: the last writer wins, as before.
 */
export type IdentityConfigPrecondition =
  | { readonly kind: 'revision'; readonly revision: string }
  | { readonly kind: 'absent' };

export interface SaveOrganizationIdentityConfigInput {
  readonly context: RequestContext;
  readonly userId: string;
  readonly organizationId: string;
  readonly issuer: string;
  readonly jwksUrl: string | null;
  readonly publicKeysJwks: PublicJsonWebKeySet | null;
  readonly allowedAlgorithms: readonly IdentityConfigAlgorithm[];
  readonly maxAssertionTtlSeconds: number;
  readonly sourceKind: 'url' | 'inline';
  readonly precondition?: IdentityConfigPrecondition;
}

export type SaveOrganizationIdentityConfigResult =
  | {
      readonly kind: 'saved' | 'unchanged';
      readonly config: StoredOrganizationIdentityConfig;
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'precondition_failed' };

export interface OrganizationIdentityConfigRepositoryPort {
  findActiveByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationIdentityConfig | null>;
  findByOrganizationId(
    organizationId: string,
  ): Promise<StoredOrganizationIdentityConfig | null>;
  saveForOwner(
    input: SaveOrganizationIdentityConfigInput,
  ): Promise<SaveOrganizationIdentityConfigResult>;
}

export const ORGANIZATION_IDENTITY_CONFIG_REPOSITORY = Symbol(
  'ORGANIZATION_IDENTITY_CONFIG_REPOSITORY',
);
