import type { ApiKeyStatus } from '@/modules/identity/domain/api-key';

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
