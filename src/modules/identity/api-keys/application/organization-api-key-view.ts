import {
  type ApiKeyStatus,
  apiKeyStatus,
} from '@/modules/identity/domain/api-key';
import type { OrganizationApiKeyRecord } from './organization-api-key.port';

/**
 * One key as the management surface presents it: the durable columns plus the
 * lifecycle AIHUB publishes, which is derived rather than stored. Listing and
 * revocation both return this, so two endpoints cannot describe one key
 * differently.
 */
export interface OrganizationApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly status: ApiKeyStatus;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * The one projection of a stored key onto its published view, at an instant.
 * Listing and revocation both call it.
 */
export function organizationApiKeyView(
  key: OrganizationApiKeyRecord,
  now: Date,
): OrganizationApiKeyView {
  return {
    id: key.apiKeyId,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    allowedEnvironments: key.allowedEnvironments,
    status: apiKeyStatus(key, now),
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
  };
}
