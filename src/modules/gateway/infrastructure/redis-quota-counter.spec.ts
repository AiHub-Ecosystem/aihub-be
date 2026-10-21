import { INCREMENT_WITH_EXPIRY_SCRIPT } from '@/common/redis/increment-with-expiry';
import {
  QUOTA_TTL_SECONDS,
  RedisQuotaCounter,
  type RedisQuotaCounterClient,
} from './redis-quota-counter';

class FakeRedis implements RedisQuotaCounterClient {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly expirations = new Map<string, number>();
  failAfterIncrement = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script !== INCREMENT_WITH_EXPIRY_SCRIPT || numberOfKeys !== 1) {
      throw new Error('unexpected quota script');
    }
    const key = String(args[0]);
    const seconds = Number(args[1]);
    this.expirations.set(key, seconds);
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    if (this.failAfterIncrement) throw new Error('redis result was ambiguous');
    return next;
  }

  async get(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

class FailingRedis implements RedisQuotaCounterClient {
  eval(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  get(): Promise<string | null> {
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
      ).rejects.toThrow('Redis quota counter value is invalid');
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

  // The month segment is built from a zero-based month plus one, so December
  // is the only value that has to carry into the next year. A key that read
  // `2026-13` would make January start on a count December had already spent.
  it('rolls the month key from December into January', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaCounter(redis, now);

    current = new Date('2026-12-31T23:59:59.000Z');
    await counter.increment({ organizationId: 'org_acme' });

    expect([...redis.values.keys()]).toEqual([
      'aihub:v1:quota:org_acme:2026-12',
    ]);

    current = new Date('2027-01-01T00:00:01.000Z');
    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(0);
  });

  it('reports an ambiguous increment result after the atomic mutation', async () => {
    const redis = new FakeRedis();
    redis.failAfterIncrement = true;
    const logger = new FakeLogger();
    const counter = new RedisQuotaCounter(redis, now, logger);

    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow('redis result was ambiguous');

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
        eval: (...args) => current.eval(...args),
        get: (key) => current.get(key),
        quit: () => current.quit(),
      },
      now,
      logger,
    );

    await expect(counter.read({ organizationId: 'org_acme' })).rejects.toThrow(
      'redis down',
    );
    await expect(counter.read({ organizationId: 'org_acme' })).rejects.toThrow(
      'redis down',
    );
    expect(logger.warnings).toHaveLength(1);

    current = healthy;
    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(0);
    expect(logger.logs).toHaveLength(1);

    current = failing;
    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow('redis down');
    expect(logger.warnings).toHaveLength(2);
  });

  it('treats an absent Redis client as unavailable', async () => {
    const counter = new RedisQuotaCounter(undefined, now);

    await expect(counter.read({ organizationId: 'org_acme' })).rejects.toThrow(
      'Redis quota counter is unavailable',
    );
    await expect(
      counter.increment({ organizationId: 'org_acme' }),
    ).rejects.toThrow('Redis quota counter is unavailable');
  });
});
