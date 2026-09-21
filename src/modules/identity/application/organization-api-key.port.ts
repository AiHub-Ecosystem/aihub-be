import type { RequestContext } from '../../../common/request-context/request-context';

import type { DurableApiKeyStatus } from './api-key-authenticator.port';

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

export interface ListOrganizationApiKeysInput {
  readonly context: RequestContext;
  readonly organizationId: string;
}

/**
 * One durable key as the management surface reads it. `status` is the column,
 * not the status the API publishes: an expired key still reads `active` here,
 * and the published lifecycle is derived from `expiresAt` in the domain.
 */
export interface OrganizationApiKeyRecord {
  readonly apiKeyId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly status: DurableApiKeyStatus;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface RotateOrganizationApiKeyRecordInput {
  readonly context: RequestContext;
  readonly organizationId: string;
  /** The key being retired. */
  readonly apiKeyId: string;
  readonly replacementId: string;
  /** Lowercase hex SHA-256 of the replacement; the raw value never arrives here. */
  readonly keyHash: string;
  readonly keyPrefix: string;
  /**
   * The application's clock. The store decides rotatability under its lock but
   * against this moment, so the expiry rule is never settled by the database's
   * clock; its canonical form is `apiKeyStatus` in the domain.
   */
  readonly now: Date;
}

export type RotateOrganizationApiKeyRecordResult =
  | {
      readonly kind: 'rotated';
      /** Lowercase hex SHA-256 of the retired key, for the cache purge only. */
      readonly retiredKeyHash: string;
      readonly name: string;
      readonly scopes: readonly string[];
      readonly allowedEnvironments: readonly string[];
      readonly expiresAt: Date | null;
      readonly createdAt: Date;
    }
  | { readonly kind: 'key_not_found' }
  | { readonly kind: 'key_not_rotatable' }
  | { readonly kind: 'organization_unavailable' };

export interface OrganizationApiKeyPort {
  createApiKey(
    input: CreateOrganizationApiKeyRecordInput,
  ): Promise<CreateOrganizationApiKeyRecordResult>;
  listApiKeys(
    input: ListOrganizationApiKeysInput,
  ): Promise<readonly OrganizationApiKeyRecord[]>;
  rotateApiKey(
    input: RotateOrganizationApiKeyRecordInput,
  ): Promise<RotateOrganizationApiKeyRecordResult>;
}

export const ORGANIZATION_API_KEY = Symbol('ORGANIZATION_API_KEY');
