import { AppError } from '@/common/errors/app-error';
import {
  recordIdentityCacheCoalescedWait,
  recordJwksRefreshFailure,
} from '@/common/observability/metrics';
import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import {
  putBounded,
  shortenedTtl,
} from '@/modules/identity/shared/infrastructure/local-cache-policy';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { JwksKeyProviderPort } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';
import { identityProviderUnavailable } from '@/modules/identity/user-assertions/application/user-identity-errors';

import {
  type DnsResolverFactory,
  defaultJwksResolverFactory,
} from './jwks-host-safety';
import {
  type JwksFetcher,
  defaultJwksFetcher,
  fetchRemoteJwks,
} from './jwks-remote-fetch';

export { JWKS_MAX_RESPONSE_BYTES } from './jwks-remote-fetch';

export const JWKS_FRESH_TTL_MS = 15 * 60 * 1_000;

export const JWKS_STALE_TTL_MS = 24 * 60 * 60 * 1_000;

export const JWKS_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;

export const JWKS_COLD_FAILURE_TTL_MS = 30 * 1_000;

export const JWKS_MAX_CONCURRENT_ORGANIZATIONS = 8;

const MAX_LOCAL_JWKS_COOLDOWNS = 256;

function remainingCooldown(
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

function setCooldown(
  cooldowns: Map<string, number>,
  key: string,
  retryAt: number,
): void {
  putBounded(cooldowns, key, retryAt, MAX_LOCAL_JWKS_COOLDOWNS);
}

class JwksCapacityError extends AppError {
  constructor() {
    super({
      code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
      message: 'JWKS source is unavailable',
      retryable: true,
    });
  }
}

export class JwksKeyProvider implements JwksKeyProviderPort {
  private readonly localRefreshCooldown = new Map<string, number>();
  private readonly refreshFailureCooldown = new Map<string, number>();
  private readonly coldFailureCooldown = new Map<string, number>();
  private readonly refreshLockFlights = new Map<
    string,
    Promise<JwksRefreshLock>
  >();
  private readonly refreshReservations = new Map<string, string>();
  private readonly flights = new Map<
    string,
    {
      readonly key: string;
      readonly promise: Promise<PublicJsonWebKeySet>;
    }
  >();

  constructor(
    private readonly cache: JwksCachePort,
    private readonly fetcher: JwksFetcher = defaultJwksFetcher,
    private readonly resolverFactory: DnsResolverFactory = defaultJwksResolverFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async validateRemote(input: {
    readonly organizationId: string;
    readonly url: string;
  }): Promise<void> {
    const snapshot = await this.cache.getJwks(input.organizationId, '1');
    await this.fetchRemoteForOrganization(
      input.organizationId,
      input.url,
      JSON.stringify(['1', snapshot.generation, input.url]),
    );
  }

  async resolve(input: {
    readonly organizationId: string;
    readonly config: OrganizationIdentityConfig;
    readonly forceRefresh?: boolean;
  }): Promise<PublicJsonWebKeySet> {
    if (input.config.jwksUrl === null) {
      if (input.config.publicKeysJwks === null) {
        throw identityProviderUnavailable();
      }
      return input.config.publicKeysJwks;
    }

    const configVersion = input.config.jwksCacheVersion ?? '1';
    const snapshot = await this.cache.getJwks(
      input.organizationId,
      configVersion,
    );
    const cacheGeneration = snapshot.generation;
    const cached = snapshot.entry;
    const now = this.now();
    const cooldownKey = JSON.stringify([input.organizationId, configVersion]);

    if (
      !input.forceRefresh &&
      cached !== undefined &&
      cached.freshUntil > now
    ) {
      return cached.jwks;
    }

    const flightKey = JSON.stringify([
      configVersion,
      cacheGeneration,
      input.config.jwksUrl,
    ]);
    const activeFlight = this.flights.get(input.organizationId);

    if (
      cached !== undefined &&
      cached.staleUntil > now &&
      !input.forceRefresh
    ) {
      if (
        remainingCooldown(this.refreshFailureCooldown, cooldownKey, now) === 0
      ) {
        this.startBackgroundRefresh(
          input.organizationId,
          configVersion,
          input.config.jwksUrl,
          cacheGeneration,
          cooldownKey,
        );
      }
      return cached.jwks;
    }

    const retryAfterMs = Math.max(
      remainingCooldown(this.refreshFailureCooldown, cooldownKey, now),
      remainingCooldown(this.coldFailureCooldown, cooldownKey, now),
    );
    if (retryAfterMs > 0) {
      if (cached !== undefined && cached.staleUntil > now) return cached.jwks;
      throw identityProviderUnavailable(undefined, retryAfterMs);
    }

    if (
      activeFlight === undefined &&
      !this.refreshReservations.has(input.organizationId) &&
      new Set([...this.flights.keys(), ...this.refreshReservations.keys()])
        .size >= JWKS_MAX_CONCURRENT_ORGANIZATIONS
    ) {
      if (cached !== undefined && cached.staleUntil > now) return cached.jwks;
      throw new JwksCapacityError();
    }

    if (
      input.forceRefresh &&
      activeFlight === undefined &&
      this.reserveRefreshSlot(input.organizationId, flightKey)
    ) {
      try {
        const lock = await this.acquireRefreshLock(input.organizationId);
        if (!lock.available) {
          if (!this.flights.has(input.organizationId)) {
            if (
              remainingCooldown(
                this.localRefreshCooldown,
                input.organizationId,
                now,
              ) > 0
            ) {
              return cached?.jwks ?? { keys: [] };
            }
            setCooldown(
              this.localRefreshCooldown,
              input.organizationId,
              now + JWKS_REFRESH_COOLDOWN_MS,
            );
          }
        } else if (!lock.acquired) {
          const localFlight = this.flights.get(input.organizationId);
          if (localFlight?.key === flightKey) {
            return localFlight.promise;
          }
          const reread = await this.cache.getJwks(
            input.organizationId,
            configVersion,
          );
          return reread.generation === cacheGeneration
            ? (reread.entry?.jwks ?? cached?.jwks ?? { keys: [] })
            : { keys: [] };
        }
      } finally {
        this.releaseRefreshSlot(input.organizationId, flightKey);
      }
    }

    try {
      const jwks = await this.fetchRemoteForOrganization(
        input.organizationId,
        input.config.jwksUrl,
        flightKey,
      );
      const refreshedAt = this.now();
      const entry: JwksCacheEntry = {
        jwks,
        freshUntil: refreshedAt + shortenedTtl(JWKS_FRESH_TTL_MS),
        staleUntil: refreshedAt + shortenedTtl(JWKS_STALE_TTL_MS),
      };
      await this.cache
        .setJwks(input.organizationId, configVersion, cacheGeneration, entry)
        .catch(() => undefined);
      this.refreshFailureCooldown.delete(cooldownKey);
      this.coldFailureCooldown.delete(cooldownKey);
      return jwks;
    } catch (error) {
      if (!(error instanceof JwksCapacityError)) {
        const hasUsableStale = cached !== undefined && cached.staleUntil > now;
        setCooldown(
          hasUsableStale
            ? this.refreshFailureCooldown
            : this.coldFailureCooldown,
          cooldownKey,
          now +
            (hasUsableStale
              ? JWKS_REFRESH_COOLDOWN_MS
              : JWKS_COLD_FAILURE_TTL_MS),
        );
      }
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
        error instanceof JwksCapacityError
          ? undefined
          : JWKS_COLD_FAILURE_TTL_MS,
      );
    }
  }

  private startBackgroundRefresh(
    organizationId: string,
    configVersion: string,
    url: string,
    generation: string,
    cooldownKey: string,
  ): void {
    const key = JSON.stringify([configVersion, generation, url]);
    if (
      this.flights.has(organizationId) ||
      this.refreshReservations.has(organizationId) ||
      !this.reserveRefreshSlot(organizationId, key)
    ) {
      return;
    }

    let refresh: Promise<PublicJsonWebKeySet>;
    try {
      refresh = this.fetchRemoteForOrganization(organizationId, url, key);
    } finally {
      this.releaseRefreshSlot(organizationId, key);
    }

    void refresh
      .then(async (jwks) => {
        const refreshedAt = this.now();
        await this.cache.setJwks(organizationId, configVersion, generation, {
          jwks,
          freshUntil: refreshedAt + shortenedTtl(JWKS_FRESH_TTL_MS),
          staleUntil: refreshedAt + shortenedTtl(JWKS_STALE_TTL_MS),
        });
        this.refreshFailureCooldown.delete(cooldownKey);
        this.coldFailureCooldown.delete(cooldownKey);
        return undefined;
      })
      .catch(() => {
        setCooldown(
          this.refreshFailureCooldown,
          cooldownKey,
          this.now() + JWKS_REFRESH_COOLDOWN_MS,
        );
        return undefined;
      });
  }

  private acquireRefreshLock(organizationId: string): Promise<JwksRefreshLock> {
    const existing = this.refreshLockFlights.get(organizationId);
    if (existing !== undefined) {
      return existing;
    }

    let flight: Promise<JwksRefreshLock>;
    flight = this.cache.tryAcquireRefresh(organizationId).finally(() => {
      if (this.refreshLockFlights.get(organizationId) === flight) {
        this.refreshLockFlights.delete(organizationId);
      }
    });
    this.refreshLockFlights.set(organizationId, flight);
    return flight;
  }

  private reserveRefreshSlot(organizationId: string, key: string): boolean {
    const existing = this.refreshReservations.get(organizationId);
    if (existing !== undefined) {
      return existing === key;
    }
    const occupied = new Set([
      ...this.flights.keys(),
      ...this.refreshReservations.keys(),
    ]);
    if (
      !occupied.has(organizationId) &&
      occupied.size >= JWKS_MAX_CONCURRENT_ORGANIZATIONS
    ) {
      return false;
    }
    this.refreshReservations.set(organizationId, key);
    return true;
  }

  private releaseRefreshSlot(organizationId: string, key: string): void {
    if (this.refreshReservations.get(organizationId) === key) {
      this.refreshReservations.delete(organizationId);
    }
  }

  private fetchRemoteForOrganization(
    organizationId: string,
    url: string,
    key = url,
  ): Promise<PublicJsonWebKeySet> {
    const existing = this.flights.get(organizationId);
    if (existing !== undefined) {
      if (existing.key !== key) return Promise.reject(new JwksCapacityError());
      recordIdentityCacheCoalescedWait('jwks');
      return existing.promise;
    }
    const reservation = this.refreshReservations.get(organizationId);
    if (reservation !== undefined && reservation !== key) {
      return Promise.reject(new JwksCapacityError());
    }
    const occupied = new Set([
      ...this.flights.keys(),
      ...this.refreshReservations.keys(),
    ]);
    if (
      !occupied.has(organizationId) &&
      occupied.size >= JWKS_MAX_CONCURRENT_ORGANIZATIONS
    ) {
      return Promise.reject(new JwksCapacityError());
    }

    let flight: {
      readonly key: string;
      readonly promise: Promise<PublicJsonWebKeySet>;
    };
    const promise = Promise.resolve()
      .then(() => fetchRemoteJwks(url, this.fetcher, this.resolverFactory))
      .catch((error: unknown) => {
        recordJwksRefreshFailure();
        throw error;
      })
      .finally(() => {
        if (this.flights.get(organizationId) === flight) {
          this.flights.delete(organizationId);
        }
      });
    flight = { key, promise };
    this.flights.set(organizationId, flight);
    return promise;
  }
}
