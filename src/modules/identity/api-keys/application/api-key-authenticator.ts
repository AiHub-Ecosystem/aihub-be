import { AppError } from '@/common/errors/app-error';
import { hashApiKey, isApiKeyFormat } from '@/modules/identity/domain/api-key';

import type {
  ApiKeyAuthenticatorPort,
  ApiKeyCachePort,
  ApiKeyCredential,
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  AuthFailureCounterPort,
  AuthenticatedApiKey,
} from './api-key-authenticator.port';

// The credential format lives in the domain so that the self-service endpoint,
// this authenticator, and the operator CLI share one definition. Only
// `isApiKeyFormat` is re-exported: the spec suite asserts through this module.
export { isApiKeyFormat } from '@/modules/identity/domain/api-key';

export const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Whether a positive record may be cached at all.
 *
 * A key bound to a single environment never is: it is re-read on every request,
 * so revocation, suspension, and a scope change are observed at the next grade
 * instead of waiting out the cache ceiling. A legacy key that still names more
 * than one environment keeps the documented 60-second ceiling.
 */
function isCacheable(record: ApiKeyRecord): boolean {
  return record.allowedEnvironments.length > 1;
}

export function effectiveScopes(record: ApiKeyRecord): readonly string[] {
  return record.scopes.filter((scope) => {
    const [entitlement] = scope.split('.');
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

export class ApiKeyAuthenticator implements ApiKeyAuthenticatorPort {
  constructor(
    private readonly repository: ApiKeyRepositoryPort,
    private readonly cache: ApiKeyCachePort,
    private readonly failureCounter: AuthFailureCounterPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authenticate(
    credentials: ApiKeyCredential,
  ): Promise<AuthenticatedApiKey> {
    if (!isApiKeyFormat(credentials.value)) {
      throw await this.invalidCredential(credentials);
    }

    const hashHex = hashApiKey(credentials.value);
    const sandbox = credentials.environment === 'sandbox';
    let record = sandbox ? undefined : await this.cacheableRecord(hashHex);

    if (record === undefined) {
      // The brute-force gate sits specifically here, in front of the
      // Postgres lookup, rather than at the top of the method: it exists to
      // protect Postgres from an IP grinding through fresh random guesses
      // (always a cache miss), not to block every request from that IP. A
      // well-formed key that is already cached — the common case for a real
      // customer, including a valid request sharing a NAT'd IP with someone
      // else's failed attempts — never pays this round trip and is never
      // gated by it, matching the "a legitimate request never touches this
      // counter" contract in the auth design.
      if (await this.isAbuseLimited(credentials)) {
        throw rateLimited();
      }

      record = await this.repository.findByHash(hashHex);
      if (!sandbox) {
        if (record === null) {
          await this.cache.setMiss(hashHex).catch(() => undefined);
        } else if (isCacheable(record)) {
          await this.cache.set(hashHex, record).catch(() => undefined);
        }
      }
    }

    if (record === null || record.status !== 'active') {
      throw await this.invalidCredential(credentials);
    }

    const now = this.now();
    if (
      record.expiresAt !== null &&
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw await this.invalidCredential(credentials);
    }

    if (record.organizationStatus !== 'active') {
      throw organizationSuspended();
    }

    if (!record.allowedEnvironments.includes(credentials.environment)) {
      throw environmentNotAllowed();
    }
    if (
      credentials.requiredAllowedEnvironments !== undefined &&
      (record.allowedEnvironments.length !==
        credentials.requiredAllowedEnvironments.length ||
        credentials.requiredAllowedEnvironments.some(
          (environment) => !record.allowedEnvironments.includes(environment),
        ))
    ) {
      throw environmentNotAllowed();
    }

    void this.repository
      .touchLastUsed(record.apiKeyId, now)
      .catch(() => undefined);

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

  /**
   * A positive record is only trusted for a key that still names more than one
   * environment. A key bound to a single environment is re-read on every
   * request, so revocation, suspension, and a scope change are observed at the
   * next grade instead of waiting out the cache ceiling. Sandbox requests never
   * consult the cache at all.
   */
  private async cacheableRecord(
    hashHex: string,
  ): Promise<ApiKeyRecord | null | undefined> {
    const record = await this.getCachedRecord(hashHex);
    return record !== null && record !== undefined && !isCacheable(record)
      ? undefined
      : record;
  }

  private abuseScopes(credentials: ApiKeyCredential): readonly string[] {
    return [credentials.clientIp, ...(credentials.additionalAbuseScopes ?? [])];
  }

  private async isAbuseLimited(
    credentials: ApiKeyCredential,
  ): Promise<boolean> {
    const counts = await Promise.all(
      this.abuseScopes(credentials).map((scope) =>
        this.failureCounter.get(scope).catch(() => 0),
      ),
    );
    return counts.some((count) => count >= AUTH_FAILURE_LIMIT);
  }

  private async invalidCredential(
    credentials: ApiKeyCredential,
  ): Promise<AppError> {
    let failures = 0;
    for (const scope of this.abuseScopes(credentials)) {
      try {
        // Redis only protects the hot path; authentication remains Postgres-backed.
        failures = Math.max(
          failures,
          await this.failureCounter.recordFailure(scope),
        );
      } catch {
        // A counter outage must never become an authorization.
      }
    }

    return failures >= AUTH_FAILURE_LIMIT ? rateLimited() : unauthorized();
  }
}
