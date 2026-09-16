import {
  QUOTA_TTL_SECONDS,
  RedisQuotaCounter,
  type RedisQuotaCounterClient,
} from './redis-quota-counter';

class FakeRedis implements RedisQuotaCounterClient {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly expirations = new Map<string, number>();
  expireResult = 1;

  async get(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.values.get(key) ?? '0');
    const next = current + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expirations.set(key, seconds);
    return this.expireResult;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

class FailingRedis implements RedisQuotaCounterClient {
  get(): Promise<string | null> {
    return Promise.reject(new Error('redis down'));
  }

  incr(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  expire(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}

class FakeLogger {
  readonly warnings: string[] = [];
  readonly logs: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

describe('RedisQuotaCounter', () => {
  let current = new Date('2026-09-16T21:00:00.000Z');
  const now = () => new Date(current.getTime());

  beforeEach(() => {
    current = new Date('2026-09-16T21:00:00.000Z');
  });

  it('reads a UTC organization-month key and treats a missing key as zero', async () => {
    const redis = new FakeRedis();
    redis.values.set('aihub:v1:quota:org_acme:2026-09', '4');
    const counter = new RedisQuotaCounter(redis, now);

    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(4);
    await expect(counter.read({ organizationId: 'org_other' })).resolves.toBe(
      0,
    );
    expect(redis.reads).toEqual([
      'aihub:v1:quota:org_acme:2026-09',
      'aihub:v1:quota:org_other:2026-09',
    ]);
  });

  it.each(['', '-1', '1.5', 'NaN', '9007199254740992'])(
    'rejects an invalid Redis counter value %s',
    async (value) => {
      const redis = new FakeRedis();
      redis.values.set('aihub:v1:quota:org_acme:2026-09', value);
      const counter = new RedisQuotaCounter(redis, now);

      await expect(
        counter.read({ organizationId: 'org_acme' }),
      ).rejects.toThrow();
    },
  );

  it('increments the billable counter and maintains its 40-day TTL', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaCounter(redis, now);

    await counter.increment({ organizationId: 'org_acme' });

    expect(redis.values.get('aihub:v1:quota:org_acme:2026-09')).toBe('1');
    expect(redis.expirations.get('aihub:v1:quota:org_acme:2026-09')).toBe(
      QUOTA_TTL_SECONDS,
    );
  });

  it('keeps the organization counter across adapter instances and months', async () => {
    const redis = new FakeRedis();
    const first = new RedisQuotaCounter(redis, now);

    await first.increment({ organizationId: 'org_acme' });

    const restarted = new RedisQuotaCounter(redis, now);
    await expect(restarted.read({ organizationId: 'org_acme' })).resolves.toBe(
      1,
    );
    await expect(restarted.read({ organizationId: 'org_other' })).resolves.toBe(
      0,
    );

    current = new Date('2026-10-01T00:00:00.000Z');
    await expect(restarted.read({ organizationId: 'org_acme' })).resolves.toBe(
      0,
    );
  });

  it('reports expiry maintenance failure after the increment', async () => {
    const redis = new FakeRedis();
    redis.expireResult = 0;
    const logger = new FakeLogger();
    const counter = new RedisQuotaCounter(redis, now, logger);

    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow();

    expect(redis.values.get('aihub:v1:quota:org_acme:2026-09')).toBe('1');
    expect(logger.warnings).toHaveLength(1);
  });

  it('logs one outage and one recovery, then can report a later outage', async () => {
    const logger = new FakeLogger();
    const failing = new FailingRedis();
    const healthy = new FakeRedis();
    let current: RedisQuotaCounterClient = failing;
    const counter = new RedisQuotaCounter(
      {
        get: (key) => current.get(key),
        incr: (key) => current.incr(key),
        expire: (key, seconds) => current.expire(key, seconds),
        quit: () => current.quit(),
      },
      now,
      logger,
    );

    await expect(
      counter.read({ organizationId: 'org_acme' }),
    ).rejects.toThrow();
    await expect(
      counter.read({ organizationId: 'org_acme' }),
    ).rejects.toThrow();
    expect(logger.warnings).toHaveLength(1);

    current = healthy;
    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(0);
    expect(logger.logs).toHaveLength(1);

    current = failing;
    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow();
    expect(logger.warnings).toHaveLength(2);
  });

  it('treats an absent Redis client as unavailable', async () => {
    const counter = new RedisQuotaCounter(undefined, now);

    await expect(
      counter.read({ organizationId: 'org_acme' }),
    ).rejects.toThrow();
    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow();
  });
});
