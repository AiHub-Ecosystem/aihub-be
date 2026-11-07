import {
  recordIdentityCacheCoalescedWait,
  recordJwksRefreshFailure,
} from '@/common/observability/metrics';
import type {
  OrganizationIdentityConfig,
  PublicJsonWebKeySet,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { shortenedTtl } from '@/modules/identity/shared/infrastructure/local-cache-policy';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import type { JwksKeyProviderPort } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';

import {
  type DnsResolverFactory,
  defaultJwksResolverFactory,
} from './jwks-host-safety';
import {
  type JwksFetcher,
  defaultJwksFetcher,
  fetchRemoteJwks,
} from './jwks-remote-fetch';
import {
  JWKS_COLD_FAILURE_TTL_MS,
  JWKS_MAX_CONCURRENT_ORGANIZATIONS,
  JwksCapacityError,
  checkJwksCapacity,
  checkJwksCooldown,
  remainingCooldown,
  resolveFreshCache,
  resolveStaticKeySet,
  setCooldown,
  translateJwksFetchError,
} from './jwks-resolution-steps';

export { JWKS_MAX_RESPONSE_BYTES } from './jwks-remote-fetch';
export {
  JWKS_COLD_FAILURE_TTL_MS,
  JWKS_MAX_CONCURRENT_ORGANIZATIONS,
  JwksCapacityError,
  checkJwksCapacity,
  checkJwksCooldown,
  resolveFreshCache,
  resolveStaticKeySet,
  translateJwksFetchError,
} from './jwks-resolution-steps';

export const JWKS_FRESH_TTL_MS = 15 * 60 * 1_000;

export const JWKS_STALE_TTL_MS = 24 * 60 * 60 * 1_000;

export const JWKS_REFRESH_COOLDOWN_MS = 5 * 60 * 1_000;

interface JwksResolutionContext {
  readonly organizationId: string;
  readonly configVersion: string;
  readonly cacheGeneration: string;
  readonly jwksUrl: string;
  readonly flightKey: string;
  readonly cooldownKey: string;
  readonly cached?: JwksCacheEntry | undefined;
  readonly forceRefresh?: boolean | undefined;
  readonly now: number;
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
    // 1. Static key-set case
    const staticKeys = resolveStaticKeySet(input.config);
    if (staticKeys !== undefined) return staticKeys;

    const configVersion = input.config.jwksCacheVersion ?? '1';
    const snapshot = await this.cache.getJwks(
      input.organizationId,
      configVersion,
    );
    const now = this.now();
    const jwksUrl = input.config.jwksUrl ?? '';
    const ctx: JwksResolutionContext = {
      organizationId: input.organizationId,
      configVersion,
      cacheGeneration: snapshot.generation,
      jwksUrl,
      flightKey: JSON.stringify([configVersion, snapshot.generation, jwksUrl]),
      cooldownKey: JSON.stringify([input.organizationId, configVersion]),
      cached: snapshot.entry,
      forceRefresh: input.forceRefresh,
      now,
    };

    // 2. Fresh cache hit
    const fresh = resolveFreshCache(ctx.cached, ctx.forceRefresh, ctx.now);
    if (fresh !== undefined) return fresh;

    // 3. Stale-while-revalidate case
    const stale = this.resolveStaleWhileRevalidate(ctx);
    if (stale !== undefined) return stale;

    // CRITICAL CHECK ORDER (#1339):
    // 1) Cooldown check must precede capacity check: on cooldown, an org receives
    //    an outage/retry hint rather than being rejected by concurrency exhaustion.
    // 2) Capacity check must precede the forced-refresh lock: full capacity must
    //    not acquire or block on cross-instance refresh locks.

    // 4. Cooldown check
    const cooldown = checkJwksCooldown({
      refreshFailureCooldown: this.refreshFailureCooldown,
      coldFailureCooldown: this.coldFailureCooldown,
      cooldownKey: ctx.cooldownKey,
      now: ctx.now,
      cached: ctx.cached,
    });
    if (cooldown !== undefined) return cooldown;

    // 5. Capacity check
    const capacity = checkJwksCapacity({
      organizationId: ctx.organizationId,
      activeFlights: this.flights,
      reservations: this.refreshReservations,
      cached: ctx.cached,
      now: ctx.now,
    });
    if (capacity !== undefined) return capacity;

    // 6. Forced refresh under the refresh lock
    const forced = await this.resolveForcedRefresh(ctx);
    if (forced !== undefined) return forced;

    // 7. Fetch-and-cache path with failure translation
    return this.fetchAndCache(ctx);
  }

  private resolveStaleWhileRevalidate(
    ctx: JwksResolutionContext,
  ): PublicJsonWebKeySet | undefined {
    if (
      !ctx.forceRefresh &&
      ctx.cached !== undefined &&
      ctx.cached.staleUntil > ctx.now
    ) {
      if (
        remainingCooldown(
          this.refreshFailureCooldown,
          ctx.cooldownKey,
          ctx.now,
        ) === 0
      ) {
        this.startBackgroundRefresh(
          ctx.organizationId,
          ctx.configVersion,
          ctx.jwksUrl,
          ctx.cacheGeneration,
          ctx.cooldownKey,
        );
      }
      return ctx.cached.jwks;
    }
    return undefined;
  }

  private async resolveForcedRefresh(
    ctx: JwksResolutionContext,
  ): Promise<PublicJsonWebKeySet | undefined> {
    if (!ctx.forceRefresh) {
      return undefined;
    }
    const { organizationId, flightKey } = ctx;
    if (
      this.flights.has(organizationId) ||
      !this.reserveRefreshSlot(organizationId, flightKey)
    ) {
      return undefined;
    }

    try {
      const lock = await this.acquireRefreshLock(organizationId);
      if (!lock.available) {
        return this.handleUnavailableRefreshLock(
          organizationId,
          ctx.cached,
          ctx.now,
        );
      }
      if (!lock.acquired) {
        return await this.handleUnacquiredRefreshLock(
          organizationId,
          ctx.configVersion,
          ctx.cacheGeneration,
          ctx.flightKey,
          ctx.cached,
        );
      }
      return undefined;
    } finally {
      this.releaseRefreshSlot(organizationId, flightKey);
    }
  }

  private handleUnavailableRefreshLock(
    organizationId: string,
    cached: JwksCacheEntry | undefined,
    now: number,
  ): PublicJsonWebKeySet | undefined {
    if (this.flights.has(organizationId)) {
      return undefined;
    }
    if (remainingCooldown(this.localRefreshCooldown, organizationId, now) > 0) {
      return cached?.jwks ?? { keys: [] };
    }
    setCooldown(
      this.localRefreshCooldown,
      organizationId,
      now + JWKS_REFRESH_COOLDOWN_MS,
    );
    return undefined;
  }

  private async handleUnacquiredRefreshLock(
    organizationId: string,
    configVersion: string,
    cacheGeneration: string,
    flightKey: string,
    cached: JwksCacheEntry | undefined,
  ): Promise<PublicJsonWebKeySet> {
    const localFlight = this.flights.get(organizationId);
    if (localFlight?.key === flightKey) {
      return localFlight.promise;
    }
    const reread = await this.cache.getJwks(organizationId, configVersion);
    return reread.generation === cacheGeneration
      ? (reread.entry?.jwks ?? cached?.jwks ?? { keys: [] })
      : { keys: [] };
  }

  private async fetchAndCache(
    ctx: JwksResolutionContext,
  ): Promise<PublicJsonWebKeySet> {
    try {
      const jwks = await this.fetchRemoteForOrganization(
        ctx.organizationId,
        ctx.jwksUrl,
        ctx.flightKey,
      );
      await this.cacheFetchedJwks(
        ctx.organizationId,
        ctx.configVersion,
        ctx.cacheGeneration,
        ctx.cooldownKey,
        jwks,
      );
      return jwks;
    } catch (error) {
      this.recordFetchFailure(error, ctx.cooldownKey, ctx.cached, ctx.now);
      return translateJwksFetchError(error, ctx.cached, ctx.now);
    }
  }

  private async cacheFetchedJwks(
    organizationId: string,
    configVersion: string,
    cacheGeneration: string,
    cooldownKey: string,
    jwks: PublicJsonWebKeySet,
  ): Promise<void> {
    const refreshedAt = this.now();
    const entry: JwksCacheEntry = {
      jwks,
      freshUntil: refreshedAt + shortenedTtl(JWKS_FRESH_TTL_MS),
      staleUntil: refreshedAt + shortenedTtl(JWKS_STALE_TTL_MS),
    };
    await this.cache
      .setJwks(organizationId, configVersion, cacheGeneration, entry)
      .catch(() => undefined);
    this.refreshFailureCooldown.delete(cooldownKey);
    this.coldFailureCooldown.delete(cooldownKey);
  }

  private recordFetchFailure(
    error: unknown,
    cooldownKey: string,
    cached: JwksCacheEntry | undefined,
    now: number,
  ): void {
    if (error instanceof JwksCapacityError) {
      return;
    }
    const hasUsableStale = cached !== undefined && cached.staleUntil > now;
    setCooldown(
      hasUsableStale ? this.refreshFailureCooldown : this.coldFailureCooldown,
      cooldownKey,
      now +
        (hasUsableStale ? JWKS_REFRESH_COOLDOWN_MS : JWKS_COLD_FAILURE_TTL_MS),
    );
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
