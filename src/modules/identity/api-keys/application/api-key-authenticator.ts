import { AppError } from '@/common/errors/app-error';
import { recordIdentityCacheCoalescedWait } from '@/common/observability/metrics';
import { recordRejected } from '@/common/observability/rejected-metric';
import { databaseUnavailableError } from '@/common/postgres/postgres-unavailable-error';
import {
  entitlementOfScope,
  isApiKeyFormat,
} from '@/modules/identity/domain/api-key';
import {
  API_KEY_LAST_USED_THROTTLE_MS,
  type ApiKeyAuthenticatorPort,
  type ApiKeyCachePort,
  type ApiKeyCredential,
  type ApiKeyRecord,
  type ApiKeyRepositoryPort,
  type AuthFailureCounterPort,
  type AuthenticatedApiKey,
} from './api-key-authenticator.port';
import { hashApiKey } from './organization-api-key-generator';

// The credential format lives in the domain so that the self-service endpoint,
// this authenticator, and the operator CLI share one definition. Only
// `isApiKeyFormat` is re-exported: the spec suite asserts through this module.
export { isApiKeyFormat } from '@/modules/identity/domain/api-key';

export const AUTH_FAILURE_LIMIT = 20;
const MAX_API_KEY_LOOKUP_FLIGHTS = 1_024;
// shortcut: 1,024 tracked keys per process; use shared TTL state if new-key
// touches must not be skipped at capacity.
export const API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT = 1_024;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

export function effectiveScopes(record: ApiKeyRecord): readonly string[] {
  return record.scopes.filter((scope) => {
    const entitlement = entitlementOfScope(scope);
    return (
      entitlement !== undefined && record.entitlements.includes(entitlement)
    );
  });
}

function unauthorized(): AppError {
  return new AppError({
    code: 'UNAUTHORIZED',
    message: 'Authentication is required',
    retryable: false,
  });
}

function environmentNotAllowed(): AppError {
  return new AppError({
    code: 'ENVIRONMENT_NOT_ALLOWED',
    message: 'API key is not allowed in this environment',
    retryable: false,
  });
}

function organizationSuspended(): AppError {
  return new AppError({
    code: 'FORBIDDEN',
    message: 'Organization is not active',
    retryable: false,
  });
}

function rateLimited(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Too many authentication failures',
    retryable: true,
    retryAfterMs: AUTH_FAILURE_WINDOW_MS,
  });
}

function apiKeyLookupCapacityExceeded(): AppError {
  return databaseUnavailableError(
    undefined,
    'API-key lookup capacity is temporarily unavailable',
  );
}

function lookupBudgetExhausted(retryAfterMs: number): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Too many API-key lookups',
    retryable: true,
    retryAfterMs,
  });
}

export class ApiKeyAuthenticator implements ApiKeyAuthenticatorPort {
  private readonly lookupFlights = new Map<
    string,
    Promise<ApiKeyRecord | null>
  >();
  private readonly recentLastUsedTouches = new Map<string, number>();

  constructor(
    private readonly repository: ApiKeyRepositoryPort,
    private readonly cache: ApiKeyCachePort,
    private readonly failureCounter: AuthFailureCounterPort,
    private readonly now: () => Date = () => new Date(),
    private readonly logEnvironmentRefusal: (apiKeyId: string) => void = () =>
      undefined,
  ) {}

  async authenticate(
    credentials: ApiKeyCredential,
  ): Promise<AuthenticatedApiKey> {
    if (!isApiKeyFormat(credentials.value)) {
      throw await this.invalidCredential(credentials.clientIp);
    }

    const hashHex = hashApiKey(credentials.value);
    if (
      credentials.environment === 'sandbox' &&
      !(await this.failureCounter
        .consumeSandboxKeyLookup(hashHex)
        .catch(() => true))
    ) {
      recordRejected('rate_limit');
      throw new AppError({
        code: 'RATE_LIMITED',
        message: 'Too many Sandbox API-key requests',
        retryable: true,
        retryAfterMs: 60_000,
      });
    }
    // Sandbox and the callers that ask for it (every grade, key validation)
    // read durable state, so revocation, suspension, and a scope change are
    // observed at the next request instead of waiting out the cache ceiling.
    const forceFresh =
      credentials.environment === 'sandbox' || credentials.forceFresh === true;
    let record = forceFresh ? undefined : await this.getCachedRecord(hashHex);

    if (record === undefined) {
      // The brute-force gate sits specifically here, in front of the
      // Postgres lookup, rather than at the top of the method: it exists to
      // protect Postgres from an IP grinding through fresh random guesses
      // (always a cache miss), not to block every request from that IP. A
      // well-formed key that is already cached â€” the common case for a real
      // customer, including a valid request sharing a NAT'd IP with someone
      // else's failed attempts â€” never pays this round trip and is never
      // gated by it, matching the "a legitimate request never touches this
      // counter" contract in the auth design.
      // Sandbox uses its per-key lookup budget so unrelated NAT failures do not block valid keys.
      if (credentials.environment !== 'sandbox') {
        const currentFailures = await this.getFailureCount(
          credentials.clientIp,
        );
        if (currentFailures >= AUTH_FAILURE_LIMIT) {
          recordRejected('auth');
          throw rateLimited();
        }
      }

      if (forceFresh) {
        await this.requireLookupBudget();
        record = await this.repository.findByHash(hashHex);
      } else {
        record = await this.findAndCache(hashHex);
      }
    }

    if (record === null || record.status !== 'active') {
      throw await this.invalidCredential(credentials.clientIp);
    }

    const now = this.now();
    if (
      record.expiresAt !== null &&
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw await this.invalidCredential(credentials.clientIp);
    }

    if (record.organizationStatus !== 'active') {
      recordRejected('auth');
      throw organizationSuspended();
    }

    if (!record.allowedEnvironments.includes(credentials.environment)) {
      await this.failureCounter
        .recordFailure(credentials.clientIp)
        .catch(() => 0);
      recordRejected('auth');
      this.logEnvironmentRefusal(record.apiKeyId);
      throw environmentNotAllowed();
    }
    this.touchLastUsedIfDue(record, now);

    return {
      organizationId: record.organizationId,
      apiKeyId: record.apiKeyId,
      environment: credentials.environment,
      scopes: effectiveScopes(record),
      rateLimitRpm: record.rateLimitRpm,
      maxConcurrent: record.maxConcurrent,
      monthlyRequestQuota: record.monthlyRequestQuota,
      hardStopOnQuota: record.hardStopOnQuota,
      allowedEnvironments: record.allowedEnvironments,
    };
  }

  private async getCachedRecord(
    hashHex: string,
  ): Promise<ApiKeyRecord | null | undefined> {
    try {
      return await this.cache.get(hashHex);
    } catch {
      return undefined;
    }
  }

  private touchLastUsedIfDue(record: ApiKeyRecord, usedAt: Date): void {
    const key = JSON.stringify([record.organizationId, record.apiKeyId]);
    const usedAtMs = usedAt.getTime();
    const previousTouchMs = this.recentLastUsedTouches.get(key);
    if (
      previousTouchMs !== undefined &&
      usedAtMs - previousTouchMs < API_KEY_LAST_USED_THROTTLE_MS
    ) {
      return;
    }

    if (previousTouchMs !== undefined) {
      this.recentLastUsedTouches.delete(key);
    }
    if (
      this.recentLastUsedTouches.size >= API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT
    ) {
      for (const [trackedKey, touchedAtMs] of this.recentLastUsedTouches) {
        if (usedAtMs - touchedAtMs >= API_KEY_LAST_USED_THROTTLE_MS) {
          this.recentLastUsedTouches.delete(trackedKey);
        }
      }
    }
    if (
      this.recentLastUsedTouches.size >= API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT
    ) {
      return;
    }
    this.recentLastUsedTouches.set(key, usedAtMs);
    void this.repository
      .touchLastUsed(record.organizationId, record.apiKeyId, usedAt)
      .catch(() => undefined);
  }

  private findAndCache(hashHex: string): Promise<ApiKeyRecord | null> {
    const existing = this.lookupFlights.get(hashHex);
    if (existing !== undefined) {
      recordIdentityCacheCoalescedWait('api_key');
      return existing;
    }
    if (this.lookupFlights.size >= MAX_API_KEY_LOOKUP_FLIGHTS) {
      throw apiKeyLookupCapacityExceeded();
    }

    let flight: Promise<ApiKeyRecord | null>;
    flight = (async () => {
      await this.requireLookupBudget();
      const freshUntil = this.cache.newPositiveFreshUntil();
      const record = await this.repository.findByHash(hashHex);
      if (record === null) {
        await this.cache.setMiss(hashHex).catch(() => undefined);
      } else {
        await this.cache
          .set(hashHex, record, freshUntil)
          .catch(() => undefined);
      }
      return record;
    })().finally(() => {
      if (this.lookupFlights.get(hashHex) === flight) {
        this.lookupFlights.delete(hashHex);
      }
    });

    this.lookupFlights.set(hashHex, flight);
    return flight;
  }

  private async requireLookupBudget() {
    const decision = await this.failureCounter.consumeUncachedLookup();
    if (!decision.allowed) {
      recordRejected('rate_limit');
      throw lookupBudgetExhausted(decision.retryAfterMs ?? 60_000);
    }
    return decision;
  }

  private async getFailureCount(ip: string): Promise<number> {
    try {
      return await this.failureCounter.get(ip);
    } catch {
      return 0;
    }
  }

  private async invalidCredential(ip: string): Promise<AppError> {
    let failures = 0;
    try {
      failures = await this.failureCounter.recordFailure(ip);
    } catch {
      // Redis only protects the hot path; authentication remains Postgres-backed.
    }

    recordRejected('auth');
    return failures >= AUTH_FAILURE_LIMIT ? rateLimited() : unauthorized();
  }
}
