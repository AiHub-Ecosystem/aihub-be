export interface ApiKeyCredential {
  readonly value: string;
  readonly environment: string;
  readonly clientIp: string;
}

export interface AuthenticatedApiKey {
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly environment: string;
  readonly scopes: readonly string[];
  readonly rateLimitRpm: number;
  readonly maxConcurrent: number;
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
  /** Sandbox per-Organization dispatch cap; null means no additional cap. */
  readonly sandboxOrganizationDispatchLimit?: number | null;
}

export type OrganizationStatus = 'active' | 'suspended';
/** The lifecycle the `api_keys` column holds. Expiry is not one of its
 * values: an expired key still reads `active` here, and the status the API
 * publishes is derived from the key's expiry moment in the domain. */
export type DurableApiKeyStatus = 'active' | 'revoked';

export interface ApiKeyRecord {
  readonly organizationId: string;
  readonly apiKeyId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly status: DurableApiKeyStatus;
  readonly scopes: readonly string[];
  readonly entitlements: readonly string[];
  readonly allowedEnvironments: readonly string[];
  readonly expiresAt: Date | null;
  readonly rateLimitRpm: number;
  readonly maxConcurrent: number;
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
}

export interface ApiKeyRepositoryPort {
  findByHash(hashHex: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(apiKeyId: string, usedAt: Date): Promise<void>;
}

export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY');

export interface ApiKeyCachePort {
  /** undefined = cache miss, null = cached negative lookup. */
  get(hashHex: string): Promise<ApiKeyRecord | null | undefined>;
  set(hashHex: string, record: ApiKeyRecord): Promise<void>;
  setMiss(hashHex: string): Promise<void>;
  delete(hashHex: string): Promise<void>;
}

export const API_KEY_CACHE = Symbol('API_KEY_CACHE');

/**
 * The Redis entries one API key hash can occupy. These names are part of the
 * cache contract rather than of the Redis adapter, so the operator commands
 * that purge a key from outside the gateway read them from here and cannot
 * drift from what the gateway writes.
 */
export function apiKeyCacheKey(hashHex: string): string {
  return `aihub:v1:key:${hashHex}`;
}

/** The negative-lookup entry; a purge must remove it too. */
export function apiKeyCacheMissKey(hashHex: string): string {
  return `aihub:v1:key:miss:${hashHex}`;
}

export interface AuthFailureCounterPort {
  get(ip: string): Promise<number>;
  recordFailure(ip: string): Promise<number>;
}

export const AUTH_FAILURE_COUNTER = Symbol('AUTH_FAILURE_COUNTER');

export interface ApiKeyAuthenticatorPort {
  authenticate(credentials: ApiKeyCredential): Promise<AuthenticatedApiKey>;
}

export const API_KEY_AUTHENTICATOR = Symbol('API_KEY_AUTHENTICATOR');
