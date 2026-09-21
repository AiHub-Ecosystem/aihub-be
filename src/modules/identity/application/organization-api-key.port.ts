import type { RequestContext } from '../../../common/request-context/request-context';

export interface CreateOrganizationApiKeyRecordInput {
  readonly context: RequestContext;
  readonly organizationId: string;
  readonly apiKeyId: string;
  /** Lowercase hex SHA-256 of the raw credential; the raw value never arrives here. */
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly expiresAt: Date | null;
  /**
   * The Entitlements the requested Scopes imply. The store checks them against
   * the Organization inside the same locked transaction that enforces the
   * active-key limit, so both guards see one consistent Organization row.
   */
  readonly requiredEntitlements: readonly string[];
  readonly activeKeyLimit: number;
}

export type CreateOrganizationApiKeyRecordResult =
  | { readonly kind: 'created'; readonly createdAt: Date }
  | { readonly kind: 'entitlements_missing' }
  | { readonly kind: 'limit_reached' }
  | { readonly kind: 'organization_unavailable' };

export interface OrganizationApiKeyPort {
  createApiKey(
    input: CreateOrganizationApiKeyRecordInput,
  ): Promise<CreateOrganizationApiKeyRecordResult>;
}

export const ORGANIZATION_API_KEY = Symbol('ORGANIZATION_API_KEY');
