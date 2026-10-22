import {
  RedisQuotaCounter,
  type RedisQuotaCounterClient,
} from './redis-quota-counter';

class FakeRedis implements RedisQuotaCounterClient {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  failAfterIncrement = false;

  // The counter's only script increments a counter that already exists.
  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (numberOfKeys !== 1) throw new Error('unexpected quota script');
    const key = String(args[0]);
    const current = this.values.get(key);
    if (current === undefined) return 0;
    const next = Number(current) + 1;
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

/** Rebuilds a lost counter from a durable count, as RedisQuotaSeeder does. */
function seederFor(redis: FakeRedis, durable: number) {
  return {
    seed: jest.fn(async (organizationId: string, at: Date) => {
      const month = at.toISOString().slice(0, 7);
      redis.values.set(
        `aihub:v1:quota:${organizationId}:${month}`,
        String(durable),
      );
    }),
  };
}

describe('RedisQuotaCounter', () => {
  let current = new Date('2026-09-16T21:00:00.000Z');
  const now = () => new Date(current.getTime());

  beforeEach(() => {
    current = new Date('2026-09-16T21:00:00.000Z');
  });

  it('reads a UTC organization-month key', async () => {
    const redis = new FakeRedis();
    redis.values.set('aihub:v1:quota:org_acme:2026-09', '4');
    const counter = new RedisQuotaCounter(redis, now);

    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(4);
    expect(redis.reads).toEqual(['aihub:v1:quota:org_acme:2026-09']);
  });

  it('never reads a missing counter as zero usage', async () => {
    const counter = new RedisQuotaCounter(new FakeRedis(), now);

    await expect(counter.read({ organizationId: 'org_lost' })).rejects.toThrow(
      'Redis quota counter is missing',
    );
  });

  it('rebuilds a missing counter from durable usage before reading it', async () => {
    const redis = new FakeRedis();
    const seeder = seederFor(redis, 37);
    const counter = new RedisQuotaCounter(redis, now, undefined, seeder);

    await expect(counter.read({ organizationId: 'org_lost' })).resolves.toBe(
      37,
    );
    expect(seeder.seed).toHaveBeenCalledWith('org_lost', now());
  });

  it('treats the quota as unverified when the rebuild fails', async () => {
    const counter = new RedisQuotaCounter(new FakeRedis(), now, undefined, {
      seed: async () => Promise.reject(new Error('db down')),
    });

    await expect(counter.read({ organizationId: 'org_lost' })).rejects.toThrow(
      'db down',
    );
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

  it('increments an existing billable counter', async () => {
    const redis = new FakeRedis();
    redis.values.set('aihub:v1:quota:org_acme:2026-09', '9');
    const counter = new RedisQuotaCounter(redis, now);

    await counter.increment({ organizationId: 'org_acme' });

    expect(redis.values.get('aihub:v1:quota:org_acme:2026-09')).toBe('10');
  });

  it('does not restart a missing counter at one', async () => {
    const redis = new FakeRedis();
    const counter = new RedisQuotaCounter(redis, now);

    await expect(
      counter.increment({ organizationId: 'org_lost' }),
    ).rejects.toThrow('Redis quota counter is missing');
    expect(redis.values.size).toBe(0);
  });

  it('keeps the organization counter across adapter instances and starts each month from durable usage', async () => {
    const redis = new FakeRedis();
    const seeder = seederFor(redis, 0);
    const first = new RedisQuotaCounter(redis, now, undefined, seeder);

    await expect(first.read({ organizationId: 'org_acme' })).resolves.toBe(0);
    await first.increment({ organizationId: 'org_acme' });

    const restarted = new RedisQuotaCounter(redis, now, undefined, seeder);
    await expect(restarted.read({ organizationId: 'org_acme' })).resolves.toBe(
      1,
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
    const counter = new RedisQuotaCounter(
      redis,
      now,
      undefined,
      seederFor(redis, 0),
    );

    current = new Date('2026-12-31T23:59:59.000Z');
    await counter.read({ organizationId: 'org_acme' });
    await counter.increment({ organizationId: 'org_acme' });

    current = new Date('2027-01-01T00:00:01.000Z');
    await expect(counter.read({ organizationId: 'org_acme' })).resolves.toBe(0);
    expect([...redis.values.entries()]).toEqual([
      ['aihub:v1:quota:org_acme:2026-12', '1'],
      ['aihub:v1:quota:org_acme:2027-01', '0'],
    ]);
  });

  it('reports an ambiguous increment result after the atomic mutation', async () => {
    const redis = new FakeRedis();
    redis.values.set('aihub:v1:quota:org_acme:2026-09', '0');
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
    healthy.values.set('aihub:v1:quota:org_acme:2026-09', '0');
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
