import { AppError } from '@/common/errors/app-error';
import { getMetrics } from '@/common/observability/metrics';
import {
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

const VALID_KEY = `aihub_sk_${'A'.repeat(43)}`;

async function rejectedAuthCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="auth"} '),
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

  constructor(public record: ApiKeyRecord | null) {}

  findByHash(_hashHex: string): Promise<ApiKeyRecord | null> {
    this.calls += 1;
    return Promise.resolve(this.record);
  }

  touchLastUsed(_apiKeyId: string, _usedAt: Date): Promise<void> {
    return Promise.resolve();
  }
}

class FakeCache implements ApiKeyCachePort {
  value: ApiKeyRecord | null | undefined = undefined;
  getCalls = 0;
  setCalls = 0;
  missCalls = 0;

  get(_hashHex: string): Promise<ApiKeyRecord | null | undefined> {
    this.getCalls += 1;
    return Promise.resolve(this.value);
  }

  set(_hashHex: string, record: ApiKeyRecord): Promise<void> {
    this.setCalls += 1;
    this.value = record;
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

  get(_ip: string): Promise<number> {
    return Promise.resolve(this.failures);
  }

  recordFailure(_ip: string): Promise<number> {
    this.failures += 1;
    return Promise.resolve(this.failures);
  }
}

function createAuthenticator(record: ApiKeyRecord | null = activeRecord): {
  authenticator: ApiKeyAuthenticator;
  repository: FakeRepository;
  cache: FakeCache;
  failures: FakeFailureCounter;
} {
  const repository = new FakeRepository(record);
  const cache = new FakeCache();
  const failures = new FakeFailureCounter();

  return {
    authenticator: new ApiKeyAuthenticator(repository, cache, failures),
    repository,
    cache,
    failures,
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

  it('rejects a key outside its environment without counting it as brute-force auth failure', async () => {
    const before = await rejectedAuthCount();
    const { authenticator, failures } = createAuthenticator({
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
    expect(failures.failures).toBe(0);
    expect(await rejectedAuthCount()).toBe(before + 1);
  });

  it.each([
    ['sandbox key on production', ['sandbox'], 'production'],
    ['production key on sandbox', ['production'], 'sandbox'],
  ])(
    'rejects a %s without counting it as brute-force auth failure',
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
      expect(failures.failures).toBe(0);
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
    const { authenticator, repository } = createAuthenticator();
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
    const { authenticator, repository } = createAuthenticator();
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
    const { authenticator, repository, cache } = createAuthenticator({
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
