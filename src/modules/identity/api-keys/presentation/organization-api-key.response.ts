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
}

/** One key in the wire shape every Organization API-key route answers with. */
export function apiKeyResponse(key: PublishedApiKey) {
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
  };
}

/** A key just minted: active, never used, and carrying its one-time secret. */
export function mintedApiKeyResponse(
  minted: Omit<PublishedApiKey, 'status' | 'lastUsedAt'> & {
    readonly apiKey: string;
  },
) {
  return {
    api_key: minted.apiKey,
    ...apiKeyResponse({ ...minted, status: 'active', lastUsedAt: null }),
  };
}
