import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';
import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { putBounded } from '@/modules/identity/shared/infrastructure/local-cache-policy';
import type { JwksCacheEntry } from '@/modules/identity/user-assertions/application/jwks-cache.port';
import { identityProviderUnavailable } from '@/modules/identity/user-assertions/application/user-identity-errors';

export const JWKS_MAX_CONCURRENT_ORGANIZATIONS = 8;
export const JWKS_COLD_FAILURE_TTL_MS = 30 * 1_000;
export const MAX_LOCAL_JWKS_COOLDOWNS = 256;

export function remainingCooldown(
  cooldowns: Map<string, number>,
  key: string,
  now: number,
): number {
  const retryAt = cooldowns.get(key);
  if (retryAt === undefined) return 0;
  if (retryAt <= now) {
    cooldowns.delete(key);
    return 0;
  }
  return Math.ceil(retryAt - now);
}

export function setCooldown(
  cooldowns: Map<string, number>,
  key: string,
  retryAt: number,
): void {
  putBounded(cooldowns, key, retryAt, MAX_LOCAL_JWKS_COOLDOWNS);
}

export class JwksCapacityError extends AppError {
  constructor() {
    super({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      message: 'JWKS source is unavailable',
      retryable: true,
    });
  }
}

export function resolveStaticKeySet(
  config: OrganizationIdentityConfig,
): PublicJsonWebKeySet | undefined {
  if (config.jwksUrl !== null) {
    return undefined;
  }
  if (config.publicKeysJwks === null) {
    throw identityProviderUnavailable();
  }
  return config.publicKeysJwks;
}

export function resolveFreshCache(
  cached: JwksCacheEntry | undefined,
  forceRefresh: boolean | undefined,
  now: number,
): PublicJsonWebKeySet | undefined {
  if (!forceRefresh && cached !== undefined && cached.freshUntil > now) {
    return cached.jwks;
  }
  return undefined;
}

export function checkJwksCooldown(input: {
  readonly refreshFailureCooldown: Map<string, number>;
  readonly coldFailureCooldown: Map<string, number>;
  readonly cooldownKey: string;
  readonly now: number;
  readonly cached?: JwksCacheEntry | undefined;
  readonly random?: (() => number) | undefined;
}): PublicJsonWebKeySet | undefined {
  const retryAfterMs = Math.max(
    remainingCooldown(
      input.refreshFailureCooldown,
      input.cooldownKey,
      input.now,
    ),
    remainingCooldown(input.coldFailureCooldown, input.cooldownKey, input.now),
  );
  if (retryAfterMs <= 0) {
    return undefined;
  }
  if (input.cached !== undefined && input.cached.staleUntil > input.now) {
    return input.cached.jwks;
  }
  throw identityProviderUnavailable(
    undefined,
    outageRetryAfterMs(input.random ?? Math.random, retryAfterMs),
  );
}

export function checkJwksCapacity(input: {
  readonly organizationId: string;
  readonly activeFlights: ReadonlyMap<string, unknown>;
  readonly reservations: ReadonlyMap<string, unknown>;
  readonly cached?: JwksCacheEntry | undefined;
  readonly now: number;
}): PublicJsonWebKeySet | undefined {
  const hasActiveFlight = input.activeFlights.has(input.organizationId);
  const hasReservation = input.reservations.has(input.organizationId);
  const occupiedCount = new Set([
    ...input.activeFlights.keys(),
    ...input.reservations.keys(),
  ]).size;

  if (
    !hasActiveFlight &&
    !hasReservation &&
    occupiedCount >= JWKS_MAX_CONCURRENT_ORGANIZATIONS
  ) {
    if (input.cached !== undefined && input.cached.staleUntil > input.now) {
      return input.cached.jwks;
    }
    throw new JwksCapacityError();
  }
  return undefined;
}

export function translateJwksFetchError(
  error: unknown,
  cached?: JwksCacheEntry,
  now = Date.now(),
  random = Math.random,
): PublicJsonWebKeySet {
  if (cached !== undefined && cached.staleUntil > now) {
    return cached.jwks;
  }
  // A typed refusal is a decision, not an outage: an unsafe address, an
  // invalid document, or an unavailable source keeps its own code instead of
  // being collapsed into IDENTITY_PROVIDER_UNAVAILABLE. Only an unexpected
  // failure is reported as an outage.
  if (
    error instanceof AppError &&
    (error.code === 'IDENTITY_JWKS_URL_UNSAFE' ||
      error.code === 'IDENTITY_JWKS_INVALID' ||
      error.code === 'IDENTITY_JWKS_SOURCE_UNAVAILABLE')
  ) {
    throw error;
  }
  throw identityProviderUnavailable(
    error,
    outageRetryAfterMs(random, JWKS_COLD_FAILURE_TTL_MS),
  );
}
