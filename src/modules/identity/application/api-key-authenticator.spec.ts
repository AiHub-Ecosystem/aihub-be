import { AppError } from '../../../common/errors/app-error';
import { ApiKeyAuthenticator } from './api-key-authenticator';
import { isApiKeyFormat } from './api-key-authenticator';
import type {
  ApiKeyCachePort,
  ApiKeyRecord,
  ApiKeyRepositoryPort,
  AuthFailureCounterPort,
} from './api-key-authenticator.port';

const VALID_KEY = `aihub_sk_${'A'.repeat(43)}`;

const activeRecord: ApiKeyRecord = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.question.generate', 'writing.grade'],
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

  constructor(private readonly record: ApiKeyRecord | null) {}

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
  setCalls = 0;
  missCalls = 0;

  get(_hashHex: string): Promise<ApiKeyRecord | null | undefined> {
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
      scopes: ['writing.question.generate', 'writing.grade'],
      rateLimitRpm: 600,
      maxConcurrent: 20,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
    });

    expect(repository.calls).toBe(1);
    expect(cache.setCalls).toBe(1);
  });

  it('rejects a missing or malformed key without touching the database', async () => {
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
  });

  it('rejects a key outside its environment without counting it as brute-force auth failure', async () => {
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
  });

  it('rejects revoked and expired keys as unauthorized credentials', async () => {
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
  });

  it('denies suspended organizations without counting them as invalid keys', async () => {
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
});
