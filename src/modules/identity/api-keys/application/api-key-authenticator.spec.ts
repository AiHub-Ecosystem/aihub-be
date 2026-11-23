import { AppError } from '@/common/errors/app-error';
import { getMetrics } from '@/common/observability/metrics/metrics';
import {
  API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT,
  AUTH_FAILURE_LIMIT,
  ApiKeyAuthenticator,
  isApiKeyFormat,
} from './api-key-authenticator';
import type {
  ApiKeyCachePort,
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  AuthFailureCounterPort,
} from './api-key-authenticator.port';
import { hashApiKey } from './organization-api-key-generator';

const VALID_KEY = `aihub_sk_${'A'.repeat(43)}`;

async function rejectedAuthCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="auth"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

async function rejectedRateLimitCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="rate_limit"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

const activeRecord: ApiKeyRecord = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.grade'],
  entitlements: ['writing'],
  allowedEnvironments: ['development', 'production'],
  expiresAt: null,
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

class FakeRepository implements ApiKeyRepositoryPort {
  calls = 0;
  touchCalls = 0;

  constructor(public record: ApiKeyRecord | null) {}

  findByHash(_hashHex: string): Promise<ApiKeyRecord | null> {
    this.calls += 1;
    return Promise.resolve(this.record);
  }

  touchLastUsed(
    _organizationId: string,
    _apiKeyId: string,
    _usedAt: Date,
  ): Promise<void> {
    this.touchCalls += 1;
    return Promise.resolve();
  }
}

class FakeCache implements ApiKeyCachePort {
  value: ApiKeyRecord | null | undefined = undefined;
  getCalls = 0;
  setCalls = 0;
  missCalls = 0;
  freshUntilCalls = 0;
  setFreshUntil: number | undefined;

  newPositiveFreshUntil(): number {
    this.freshUntilCalls += 1;
    return Date.now() + 60_000;
  }

  get(_hashHex: string): Promise<ApiKeyRecord | null | undefined> {
    this.getCalls += 1;
    return Promise.resolve(this.value);
  }

  set(
    _hashHex: string,
    record: ApiKeyRecord,
    freshUntil?: number,
  ): Promise<void> {
    this.setCalls += 1;
    this.setFreshUntil = freshUntil;
    this.value =
      freshUntil !== undefined && freshUntil <= Date.now() ? undefined : record;
    return Promise.resolve();
  }

  setMiss(_hashHex: string): Promise<void> {
    this.missCalls += 1;
    this.value = null;
    return Promise.resolve();
  }

  delete(_hashHex: string): Promise<void> {
    this.value = undefined;
    return Promise.resolve();
  }
}

class FakeFailureCounter implements AuthFailureCounterPort {
  failures = 0;
  sandboxLookups = 0;
  sandboxLookupAllowed = true;
  uncachedLookups = 0;
  uncachedLookupAllowed = true;

  get(_ip: string): Promise<number> {
    return Promise.resolve(this.failures);
  }

  recordFailure(_ip: string): Promise<number> {
    this.failures += 1;
    return Promise.resolve(this.failures);
  }

  consumeSandboxKeyLookup(_hashHex: string): Promise<boolean> {
    this.sandboxLookups += 1;
    return Promise.resolve(this.sandboxLookupAllowed);
  }

  consumeUncachedLookup() {
    this.uncachedLookups += 1;
    return Promise.resolve(
      this.uncachedLookupAllowed
        ? { allowed: true as const }
        : {
            allowed: false as const,
            retryAfterMs: 45_000,
          },
    );
  }
}

function createAuthenticator(
  record: ApiKeyRecord | null = activeRecord,
  now: () => Date = () => new Date(),
): {
  authenticator: ApiKeyAuthenticator;
  repository: FakeRepository;
  cache: FakeCache;
  failures: FakeFailureCounter;
  environmentRefusals: string[];
} {
  const repository = new FakeRepository(record);
  const cache = new FakeCache();
  const failures = new FakeFailureCounter();
  const environmentRefusals: string[] = [];

  return {
    authenticator: new ApiKeyAuthenticator(
      repository,
      cache,
      failures,
      now,
      (apiKeyId) => environmentRefusals.push(apiKeyId),
    ),
    repository,
    cache,
    failures,
    environmentRefusals,
  };
}

describe('ApiKeyAuthenticator', () => {
  it('accepts only the prefixed 256-bit base62 credential shape', () => {
    expect(isApiKeyFormat(VALID_KEY)).toBe(true);
    expect(isApiKeyFormat(`aihub_sk_${'A'.repeat(42)}`)).toBe(false);
    expect(isApiKeyFormat(`other_sk_${'A'.repeat(43)}`)).toBe(false);
    expect(isApiKeyFormat(`aihub_sk_${'!'.repeat(43)}`)).toBe(false);
  });

  it('hashes, looks up, validates, and returns effective organization identity', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, repository, cache } = createAuthenticator();

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      environment: 'production',
      scopes: ['writing.grade'],
      rateLimitRpm: 600,
      maxConcurrent: 20,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
      allowedEnvironments: ['development', 'production'],
    });

    expect(repository.calls).toBe(1);
    expect(cache.setCalls).toBe(1);
    expect(await rejectedAuthCount()).toBe(before);
  });

  it('dispatches last-used touches once per minute, then resumes after the window', async () => {
    let now = new Date('2026-11-19T12:00:00.000Z');
    const { authenticator, repository } = createAuthenticator(
      activeRecord,
      () => now,
    );
    const credentials = {
      value: VALID_KEY,
      environment: 'production',
      clientIp: '203.0.113.10',
    };

    await authenticator.authenticate(credentials);
    now = new Date(now.getTime() + 59_999);
    await authenticator.authenticate(credentials);
    expect(repository.touchCalls).toBe(1);

    now = new Date(now.getTime() + 1);
    await authenticator.authenticate(credentials);
    expect(repository.touchCalls).toBe(2);
  });

  it('does not evict a live window at capacity; admits overflow after expiry', async () => {
    let now = new Date('2026-11-19T12:00:00.000Z');
    const { authenticator, repository, cache } = createAuthenticator(
      activeRecord,
      () => now,
    );

    for (
      let index = 0;
      index < API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT;
      index += 1
    ) {
      repository.record = { ...activeRecord, apiKeyId: `ak_${index}` };
      cache.value = undefined;
      await authenticator.authenticate({
        value: `aihub_sk_${String(index).padStart(43, 'A')}`,
        environment: 'production',
        clientIp: '203.0.113.10',
      });
    }
    expect(repository.touchCalls).toBe(API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT);

    repository.record = { ...activeRecord, apiKeyId: 'ak_overflow' };
    cache.value = undefined;
    await authenticator.authenticate({
      value: `aihub_sk_${'A'.repeat(42)}1`,
      environment: 'production',
      clientIp: '203.0.113.10',
    });
    expect(repository.touchCalls).toBe(API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT);

    now = new Date(now.getTime() + 59_999);
    repository.record = { ...activeRecord, apiKeyId: 'ak_0' };
    cache.value = repository.record;
    await authenticator.authenticate({
      value: `aihub_sk_${'A'.repeat(42)}0`,
      environment: 'production',
      clientIp: '203.0.113.10',
    });
    expect(repository.touchCalls).toBe(API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT);

    now = new Date(now.getTime() + 1);
    await authenticator.authenticate({
      value: `aihub_sk_${'A'.repeat(42)}0`,
      environment: 'production',
      clientIp: '203.0.113.10',
    });
    expect(repository.touchCalls).toBe(
      API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT + 1,
    );

    repository.record = { ...activeRecord, apiKeyId: 'ak_overflow' };
    cache.value = repository.record;
    await authenticator.authenticate({
      value: `aihub_sk_${'A'.repeat(42)}1`,
      environment: 'production',
      clientIp: '203.0.113.10',
    });
    expect(repository.touchCalls).toBe(
      API_KEY_LAST_USED_TOUCH_TRACKING_LIMIT + 2,
    );
  });

  it('rejects a missing or malformed key without touching the database', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, repository, failures } = createAuthenticator();

    const error = await authenticator
      .authenticate({
        value: 'not-a-key',
        environment: 'development',
        clientIp: '203.0.113.10',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNAUTHORIZED');
    expect(repository.calls).toBe(0);
    expect(failures.failures).toBe(1);
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('counts and logs a cross-environment key refusal as an auth failure', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, failures, environmentRefusals } =
      createAuthenticator({
        ...activeRecord,
        allowedEnvironments: ['production'],
      });

    const error = await authenticator
      .authenticate({
        value: VALID_KEY,
        environment: 'development',
        clientIp: '203.0.113.10',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('ENVIRONMENT_NOT_ALLOWED');
    expect(failures.failures).toBe(1);
    expect(environmentRefusals).toEqual(['ak_backend']);
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it.each([
    ['sandbox key on production', ['sandbox'], 'production'],
    ['production key on sandbox', ['production'], 'sandbox'],
  ])(
    'rejects a %s and records the authentication failure',
    async (_label, allowedEnvironments, requestEnvironment) => {
      const { authenticator, failures } = createAuthenticator({
        ...activeRecord,
        allowedEnvironments,
      });

      await expect(
        authenticator.authenticate({
          value: VALID_KEY,
          environment: requestEnvironment,
          clientIp: '203.0.113.10',
        }),
      ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
      expect(failures.failures).toBe(1);
    },
  );

  it('rejects revoked and expired keys as unauthorized credentials', async () => {
    const before = await rejectedAuthCount();
    const revoked = createAuthenticator({ ...activeRecord, status: 'revoked' });
    await expect(
      revoked.authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const expired = createAuthenticator({
      ...activeRecord,
      expiresAt: new Date('2026-09-06T00:00:00.000Z'),
    });
    const expiredAuthenticator = new ApiKeyAuthenticator(
      expired.repository,
      expired.cache,
      expired.failures,
      () => new Date('2026-09-07T00:00:00.000Z'),
    );
    await expect(
      expiredAuthenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await rejectedAuthCount()).toBe(before + 2);
  });

  it('denies suspended organizations without counting them as invalid keys', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, failures } = createAuthenticator({
      ...activeRecord,
      organizationStatus: 'suspended',
    });

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(failures.failures).toBe(0);
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('caches a negative lookup and rejects it without repeated Postgres queries', async () => {
    const { authenticator, repository, cache } = createAuthenticator(null);
    const credentials = {
      value: VALID_KEY,
      environment: 'development',
      clientIp: '203.0.113.10',
    };

    await expect(authenticator.authenticate(credentials)).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );
    await expect(authenticator.authenticate(credentials)).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );

    expect(repository.calls).toBe(1);
    expect(cache.missCalls).toBe(1);
  });

  it('shares an ordinary Postgres lookup between concurrent misses for one key', async () => {
    const { authenticator, repository, failures } = createAuthenticator();
    let releaseLookup: ((record: ApiKeyRecord | null) => void) | undefined;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookup = new Promise<ApiKeyRecord | null>((resolve) => {
      releaseLookup = resolve;
    });
    repository.findByHash = () => {
      repository.calls += 1;
      markLookupStarted?.();
      return lookup;
    };
    const credentials = {
      value: VALID_KEY,
      environment: 'production',
      clientIp: '203.0.113.10',
    };

    const first = authenticator.authenticate(credentials);
    await lookupStarted;
    const second = authenticator.authenticate(credentials);
    releaseLookup?.(activeRecord);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(repository.calls).toBe(1);
    expect(failures.uncachedLookups).toBe(1);
  });

  it('does not cache a positive lookup after its pre-lookup deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
    try {
      const { authenticator, repository, cache } = createAuthenticator();
      let releaseLookup: ((record: ApiKeyRecord | null) => void) | undefined;
      let markLookupStarted: (() => void) | undefined;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      repository.findByHash = () => {
        repository.calls += 1;
        markLookupStarted?.();
        return new Promise((resolve) => {
          releaseLookup = resolve;
        });
      };

      const originalFreshUntil = Date.now() + 60_000;
      const authentication = authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      });
      await lookupStarted;
      jest.advanceTimersByTime(60_001);
      releaseLookup?.(activeRecord);

      await expect(authentication).resolves.toMatchObject({
        organizationId: activeRecord.organizationId,
      });
      expect(cache.setFreshUntil).toBe(originalFreshUntil);
      expect(cache.value).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a new hash at flight capacity while coalescing an existing hash', async () => {
    const { authenticator, repository, cache } = createAuthenticator();
    const maxFlights = 1_024;
    const pendingLookups: Array<(record: ApiKeyRecord | null) => void> = [];
    let markCapacityReached: (() => void) | undefined;
    const capacityReached = new Promise<void>((resolve) => {
      markCapacityReached = resolve;
    });
    repository.findByHash = () => {
      repository.calls += 1;
      return new Promise((resolve) => {
        pendingLookups.push(resolve);
        if (pendingLookups.length === maxFlights) markCapacityReached?.();
      });
    };
    cache.get = () => Promise.resolve(undefined);
    cache.set = () => Promise.resolve();
    cache.setMiss = () => Promise.resolve();

    const authenticateKey = (index: number) =>
      authenticator.authenticate({
        value: `aihub_sk_${index.toString(36).padStart(43, 'A')}`,
        environment: 'production',
        clientIp: '203.0.113.10',
      });
    const requests = Array.from({ length: maxFlights }, (_, index) =>
      authenticateKey(index),
    );
    await capacityReached;

    const overflow = authenticateKey(maxFlights);
    await expect(overflow).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      // The hint is spread over [1 s, 2 s) (#1352).
      retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
    });
    const sameHash = authenticateKey(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repository.calls).toBe(maxFlights);

    pendingLookups.forEach((resolve) => resolve(activeRecord));

    await expect(Promise.all([...requests, sameHash])).resolves.toHaveLength(
      maxFlights + 1,
    );
    expect(repository.calls).toBe(maxFlights);
  });

  it('does not coalesce concurrent forceFresh Postgres lookups', async () => {
    const { authenticator, repository, cache } = createAuthenticator();
    const credentials = {
      value: VALID_KEY,
      environment: 'production',
      clientIp: '203.0.113.10',
      forceFresh: true,
    };

    await expect(
      Promise.all([
        authenticator.authenticate(credentials),
        authenticator.authenticate(credentials),
      ]),
    ).resolves.toHaveLength(2);
    expect(repository.calls).toBe(2);
    expect(cache.getCalls).toBe(0);
    expect(cache.freshUntilCalls).toBe(0);
    expect(cache.setCalls).toBe(0);
    expect(cache.missCalls).toBe(0);
  });

  it('bypasses both cache tiers for Sandbox authentication', async () => {
    const { authenticator, repository, cache, failures } = createAuthenticator({
      ...activeRecord,
      allowedEnvironments: ['sandbox'],
    });

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'sandbox',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toMatchObject({ environment: 'sandbox' });

    expect(repository.calls).toBe(1);
    expect(failures.sandboxLookups).toBe(1);
    expect(cache.getCalls).toBe(0);
    expect(cache.freshUntilCalls).toBe(0);
    expect(cache.setCalls).toBe(0);
    expect(cache.missCalls).toBe(0);
  });

  it('returns 429 after the brute-force threshold is reached', async () => {
    const { authenticator, failures } = createAuthenticator(null);
    failures.failures = 19;

    const error = await authenticator
      .authenticate({
        value: 'not-a-key',
        environment: 'development',
        clientIp: '203.0.113.10',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect((error as AppError).httpStatus).toBe(429);
  });

  it('rejects a fresh guess without touching Postgres once the IP is over the brute-force threshold', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, repository, failures } = createAuthenticator(null);
    failures.failures = AUTH_FAILURE_LIMIT;

    const error = await authenticator
      .authenticate({
        value: VALID_KEY,
        environment: 'development',
        clientIp: '203.0.113.10',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect(repository.calls).toBe(0);
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it('refuses an uncached lookup before Postgres when the deployment-wide budget is spent', async () => {
    const before = await rejectedRateLimitCount();
    const { authenticator, repository, failures } = createAuthenticator();
    failures.uncachedLookupAllowed = false;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 45_000,
    });
    expect(repository.calls).toBe(0);
    expect(await rejectedRateLimitCount()).toBe(before + 1);
    const metrics = await getMetrics();
    expect(metrics).not.toContain(VALID_KEY);
    expect(metrics).not.toContain(hashApiKey(VALID_KEY));
    expect(metrics).not.toContain('203.0.113.10');
  });

  it('does not spend the lookup budget on a cached key or on a malformed credential', async () => {
    const { authenticator, cache, failures } = createAuthenticator();
    cache.value = activeRecord;

    await authenticator.authenticate({
      value: VALID_KEY,
      environment: 'production',
      clientIp: '203.0.113.10',
    });
    await authenticator
      .authenticate({
        value: 'not-a-key',
        environment: 'production',
        clientIp: '203.0.113.10',
      })
      .catch(() => undefined);

    expect(failures.uncachedLookups).toBe(0);
  });

  it('still authenticates a cached key while the uncached lookup budget is exhausted', async () => {
    const { authenticator, cache, failures } = createAuthenticator();
    cache.value = activeRecord;
    failures.uncachedLookupAllowed = false;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toMatchObject({ organizationId: 'org_acme' });
  });

  it('spends the lookup budget on Sandbox fresh reads as well', async () => {
    const { authenticator, repository, failures } = createAuthenticator({
      ...activeRecord,
      allowedEnvironments: ['sandbox'],
    });
    failures.uncachedLookupAllowed = false;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'sandbox',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(failures.uncachedLookups).toBe(1);
    expect(repository.calls).toBe(0);
  });

  it('passes a budgeted miss to the bounded cache port', async () => {
    const { authenticator, repository, cache } = createAuthenticator(null);

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(repository.calls).toBe(1);
    expect(cache.missCalls).toBe(1);
  });

  it('does not spend a failure-counter round trip on a valid, already-cached key', async () => {
    const { authenticator, repository, cache, failures } =
      createAuthenticator();
    cache.value = activeRecord;
    let getCalls = 0;
    const originalGet = failures.get.bind(failures);
    failures.get = (ip: string) => {
      getCalls += 1;
      return originalGet(ip);
    };

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toMatchObject({ organizationId: 'org_acme' });

    expect(repository.calls).toBe(0);
    expect(getCalls).toBe(0);
  });

  it('still accepts a valid, already-cached key even when its IP is over the brute-force threshold', async () => {
    // A NAT'd IP shared with someone else's failed attempts must not block
    // this customer's genuinely valid, cached request.
    const { authenticator, cache, failures } = createAuthenticator();
    cache.value = activeRecord;
    failures.failures = AUTH_FAILURE_LIMIT;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toMatchObject({ organizationId: 'org_acme' });
  });

  it('reads Sandbox keys from Postgres on every request without reading or populating the key cache', async () => {
    const { authenticator, repository, cache, failures } = createAuthenticator({
      ...activeRecord,
      allowedEnvironments: ['sandbox'],
    });
    cache.value = { ...activeRecord, status: 'revoked' };
    const credentials = {
      value: VALID_KEY,
      environment: 'sandbox',
      clientIp: '203.0.113.10',
    };

    await expect(
      authenticator.authenticate(credentials),
    ).resolves.toMatchObject({
      organizationId: 'org_acme',
    });
    await expect(
      authenticator.authenticate(credentials),
    ).resolves.toMatchObject({
      organizationId: 'org_acme',
    });

    expect(repository.calls).toBe(2);
    expect(cache.getCalls).toBe(0);
    expect(cache.setCalls).toBe(0);
    expect(cache.missCalls).toBe(0);
    expect(failures.sandboxLookups).toBe(2);
  });

  it('does not let another Sandbox customer’s failures behind a NAT block this key', async () => {
    const { authenticator, failures } = createAuthenticator({
      ...activeRecord,
      allowedEnvironments: ['sandbox'],
    });
    failures.failures = AUTH_FAILURE_LIMIT;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'sandbox',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toMatchObject({ organizationId: 'org_acme' });
  });

  it('applies the Sandbox per-key limit before the control-plane lookup', async () => {
    const { authenticator, repository, failures } = createAuthenticator({
      ...activeRecord,
      allowedEnvironments: ['sandbox'],
    });
    failures.sandboxLookupAllowed = false;

    await expect(
      authenticator.authenticate({
        value: VALID_KEY,
        environment: 'sandbox',
        clientIp: '203.0.113.10',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(repository.calls).toBe(0);
  });

  it('observes revocation on a forced-fresh grade authorization despite a cached positive record', async () => {
    const { authenticator, repository, cache } = createAuthenticator();
    cache.value = activeRecord;
    const credentials = {
      value: VALID_KEY,
      environment: 'production',
      clientIp: '203.0.113.10',
      forceFresh: true,
    };

    await expect(
      authenticator.authenticate(credentials),
    ).resolves.toMatchObject({ organizationId: 'org_acme' });
    repository.record = { ...activeRecord, status: 'revoked' };
    await expect(authenticator.authenticate(credentials)).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' },
    );
    expect(repository.calls).toBe(2);
    expect(cache.getCalls).toBe(0);
    expect(cache.setCalls).toBe(0);
  });

  it.each([
    ['aihub_sandbox_', 'sandbox'],
    ['aihub_prod_', 'production'],
  ])(
    'authenticates a credential issued under the %s prefix only in its own environment',
    async (prefix, environment) => {
      const { authenticator } = createAuthenticator({
        ...activeRecord,
        allowedEnvironments: [environment],
      });
      const value = `${prefix}${'A'.repeat(43)}`;

      await expect(
        authenticator.authenticate({
          value,
          environment,
          clientIp: '203.0.113.10',
        }),
      ).resolves.toMatchObject({ organizationId: 'org_acme' });
      await expect(
        authenticator.authenticate({
          value,
          environment: 'development',
          clientIp: '203.0.113.10',
        }),
      ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
    },
  );
});
