import { AppError } from '../../../common/errors/app-error';
import { hashApiKey, isApiKeyFormat } from '../domain/api-key';

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
export { isApiKeyFormat } from '../domain/api-key';

export const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

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
      throw await this.invalidCredential(credentials.clientIp);
    }

    const hashHex = hashApiKey(credentials.value);
    let record = await this.getCachedRecord(hashHex);

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
      const currentFailures = await this.getFailureCount(credentials.clientIp);
      if (currentFailures >= AUTH_FAILURE_LIMIT) {
        throw rateLimited();
      }

      record = await this.repository.findByHash(hashHex);
      if (record === null) {
        await this.cache.setMiss(hashHex).catch(() => undefined);
      } else {
        await this.cache.set(hashHex, record).catch(() => undefined);
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
      throw organizationSuspended();
    }

    if (!record.allowedEnvironments.includes(credentials.environment)) {
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

    return failures >= AUTH_FAILURE_LIMIT ? rateLimited() : unauthorized();
  }
}
