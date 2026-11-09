import type { OrganizationApiKey } from '@/contracts/organization/api-key';
import type { ApiKeyStatus } from '@/modules/identity/domain/api-key';

interface PublishedApiKey {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly status: ApiKeyStatus;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  /** Who created the key and who last rotated it, by immutable username. */
  readonly createdByUsername: string | null;
  readonly lastRotatedByUsername: string | null;
}

/** One key in the wire shape every Organization API-key route answers with. */
export function apiKeyResponse(key: PublishedApiKey): OrganizationApiKey {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scopes: [...key.scopes],
    allowed_environments: [...key.allowedEnvironments],
    status: key.status,
    expires_at: key.expiresAt?.toISOString() ?? null,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    created_at: key.createdAt.toISOString(),
    created_by: key.createdByUsername,
    last_rotated_by: key.lastRotatedByUsername,
  };
}

export interface MintedApiKeyResponse extends OrganizationApiKey {
  readonly api_key: string;
}

/** A key just minted: active, never used, and carrying its one-time secret. */
export function mintedApiKeyResponse(
  minted: Omit<PublishedApiKey, 'status' | 'lastUsedAt'> & {
    readonly apiKey: string;
  },
): MintedApiKeyResponse {
  return {
    api_key: minted.apiKey,
    ...apiKeyResponse({ ...minted, status: 'active', lastUsedAt: null }),
  };
}
