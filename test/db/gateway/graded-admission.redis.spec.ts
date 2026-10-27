import { createHash, randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import type { GradedAdmissionRequest } from '@/modules/gateway/application/graded-admission.port';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import {
  GRADED_ADMISSION_SCRIPT,
  RedisGradedAdmission,
} from '@/modules/gateway/infrastructure/redis-graded-admission';
import { quotaKeyForMonth } from '@/modules/gateway/infrastructure/redis-quota-counter';
import { flushOwnedRedisDatabase } from '../../../scripts/checks/db-lane/ownership';
import {
  createSandboxTestRedis,
  sandboxTestRedisUrl,
} from '../shared/database';

// The combined script is the one place the rate limit, the Organization retry
// budget, and the monthly quota are ordered (ADR-0057). Fakes cannot show the
// order or the sliding window, so this runs the real script on a real Redis.

let redis: Redis;
let client: RedisGatewayClient;
let admission: RedisGradedAdmission;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function request(
  overrides: Partial<GradedAdmissionRequest> = {},
): GradedAdmissionRequest {
  return {
    apiKeyId: `ak_${randomUUID()}`,
    rateLimitRpm: 100,
    organizationId: `org_${randomUUID()}`,
    requestId: `req_${randomUUID()}`,
    operation: 'writing.task1.grade',
    idempotencyKey: `key_${randomUUID()}`,
    monthlyRequestQuota: null,
    hardStopOnQuota: false,
    ...overrides,
  };
}

function quotaKey(organizationId: string): string {
  return quotaKeyForMonth(organizationId, quotaPeriod(new Date()).key);
}

function retryPrefix(organizationId: string): string {
  return `aihub:v1:org-retry:{${digest(organizationId)}}`;
}

beforeAll(async () => {
  redis = createSandboxTestRedis();
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  }
  await flushOwnedRedisDatabase(
    redis.duplicate({ db: 0, enableOfflineQueue: true }),
    () => redis.flushdb(),
    'SANDBOX_TEST_REDIS_URL',
  );
  const created = createRedisGatewayClient(sandboxTestRedisUrl());
  if (created === undefined) throw new Error('expected a Redis gateway client');
  client = created;
  // The gateway client has no offline queue, so a command sent before the
  // socket connects fails; wait for the first PING.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.ping();
      break;
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  admission = new RedisGradedAdmission(client);
});

afterAll(async () => {
  await client?.quit();
  await redis?.quit().catch(() => undefined);
});

describe('graded admission script on a real Redis', () => {
  it('admits a request and reports the key standing', async () => {
    const decision = await admission.consume(request({ rateLimitRpm: 5 }));

    expect(decision).toMatchObject({
      stage: 'admitted',
      rate: { limit: 5, remaining: 4 },
    });
  });

  it('refuses with rate_limit once the key passes its per-minute count', async () => {
    const input = request({ rateLimitRpm: 2 });

    await admission.consume({ ...input, requestId: 'r1' });
    await admission.consume({ ...input, requestId: 'r2' });
    const third = await admission.consume({ ...input, requestId: 'r3' });

    expect(third.stage).toBe('rate_limit');
  });

  it('allows one same-key repeat for one first attempt, then refuses with retry_budget', async () => {
    const input = request();

    const first = await admission.consume({ ...input, requestId: 'r1' });
    const repeat = await admission.consume({ ...input, requestId: 'r2' });
    const second = await admission.consume({ ...input, requestId: 'r3' });

    expect([first.stage, repeat.stage, second.stage]).toEqual([
      'admitted',
      'admitted',
      'retry_budget',
    ]);
    if (second.stage !== 'retry_budget') throw new Error('expected a refusal');
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts nothing for a refused repeat, and the allowance widens as first attempts grow', async () => {
    const organizationId = `org_${randomUUID()}`;
    const input = request({ organizationId });
    const prefix = retryPrefix(organizationId);

    await admission.consume({ ...input, requestId: 'r1' });
    await admission.consume({ ...input, requestId: 'r2' });
    const refusedOnce = await admission.consume({ ...input, requestId: 'r3' });
    const refusedTwice = await admission.consume({ ...input, requestId: 'r4' });

    expect([refusedOnce.stage, refusedTwice.stage]).toEqual([
      'retry_budget',
      'retry_budget',
    ]);
    await expect(redis.zcard(`${prefix}:first`)).resolves.toBe(1);
    await expect(redis.zcard(`${prefix}:repeats`)).resolves.toBe(1);

    // 20 first attempts in the window allow floor(20 * 10%) = 2 repeats.
    for (let index = 0; index < 19; index += 1) {
      await admission.consume(request({ organizationId }));
    }
    const widened = await admission.consume({ ...input, requestId: 'r5' });

    expect(widened.stage).toBe('admitted');
    await expect(redis.zcard(`${prefix}:repeats`)).resolves.toBe(2);
  });

  it('treats the same key on another operation as a new first attempt', async () => {
    const organizationId = `org_${randomUUID()}`;
    const input = request({ organizationId });

    await admission.consume({ ...input, requestId: 'r1' });
    await admission.consume({ ...input, requestId: 'r2' });
    const otherOperation = await admission.consume({
      ...input,
      requestId: 'r3',
      operation: 'writing.task2.grade',
    });

    expect(otherOperation.stage).toBe('admitted');
    await expect(
      redis.zcard(`${retryPrefix(organizationId)}:first`),
    ).resolves.toBe(2);
    await expect(
      redis.zcard(`${retryPrefix(organizationId)}:repeats`),
    ).resolves.toBe(1);
  });

  it('applies the rate limit before the retry budget', async () => {
    const input = request({ rateLimitRpm: 2 });

    await admission.consume({ ...input, requestId: 'r1' });
    await admission.consume({ ...input, requestId: 'r2' });
    // A third same-key repeat would also exhaust the retry budget.
    const third = await admission.consume({ ...input, requestId: 'r3' });

    expect(third.stage).toBe('rate_limit');
  });

  it('applies the retry budget before the quota', async () => {
    const input = request({ monthlyRequestQuota: 5 });
    await redis.set(quotaKey(input.organizationId), '5');

    const stages = [];
    for (const requestId of ['r1', 'r2', 'r3']) {
      stages.push((await admission.consume({ ...input, requestId })).stage);
    }

    // The first attempt and one repeat pass the retry budget and meet the
    // exhausted quota; the next repeat is refused by the retry budget first.
    expect(stages).toEqual(['quota', 'quota', 'retry_budget']);
  });

  it('refuses with quota only once the counter reaches the quota', async () => {
    const input = request({ monthlyRequestQuota: 5 });
    await redis.set(quotaKey(input.organizationId), '4');
    const under = await admission.consume(input);
    await redis.set(quotaKey(input.organizationId), '5');
    const reached = await admission.consume(request({ ...input }));

    expect(under.stage).toBe('admitted');
    expect(reached).toMatchObject({ stage: 'quota', quota: 5 });
  });

  it('writes nothing when a hard-stop quota counter is missing and cannot be rebuilt', async () => {
    const input = request({ monthlyRequestQuota: 5, hardStopOnQuota: true });

    await expect(admission.consume(input)).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
    });

    await expect(
      redis.keys(`aihub:v1:rl:${input.apiKeyId}:*`),
    ).resolves.toEqual([]);
    await expect(
      redis.exists(`${retryPrefix(input.organizationId)}:first`),
    ).resolves.toBe(0);
  });

  it('rebuilds a missing counter through the seeder and then admits', async () => {
    const input = request({ monthlyRequestQuota: 5, hardStopOnQuota: true });
    const seeded = new RedisGradedAdmission(
      client,
      undefined,
      undefined,
      undefined,
      {
        seed: async (organizationId) => {
          await redis.set(quotaKey(organizationId), '0');
        },
      },
    );

    const decision = await seeded.consume(input);

    expect(decision.stage).toBe('admitted');
    expect(decision).not.toHaveProperty('quotaUnverified');
  });

  it('admits a soft-quota Organization as quotaUnverified when the counter cannot be rebuilt', async () => {
    const decision = await admission.consume(
      request({ monthlyRequestQuota: 5, hardStopOnQuota: false }),
    );

    expect(decision).toMatchObject({
      stage: 'admitted',
      quotaUnverified: true,
    });
  });
});

describe('graded admission retry ledger', () => {
  function scriptKeys(organizationId: string, apiKeyId: string): string[] {
    const prefix = retryPrefix(organizationId);
    return [
      `aihub:v1:rl:${apiKeyId}:ledger`,
      `${prefix}:first`,
      `${prefix}:repeats`,
      `${prefix}:seen`,
      quotaKey(organizationId),
    ];
  }

  function run(
    keys: readonly string[],
    member: string,
    requestId: string,
    cap = 10_000,
  ): Promise<readonly number[]> {
    return client.evalNumbers(
      GRADED_ADMISSION_SCRIPT,
      5,
      ...keys,
      '1000',
      '1',
      member,
      requestId,
      String(cap),
      '',
    );
  }

  it('bounds the remembered keys at the cap, dropping the oldest', async () => {
    const keys = scriptKeys(`org_${randomUUID()}`, `ak_${randomUUID()}`);

    for (let index = 0; index < 5; index += 1) {
      await run(keys, `member-${index}`, `req-${index}`, 3);
    }

    await expect(redis.zcard(keys[3] ?? '')).resolves.toBe(3);
    await expect(redis.zscore(keys[3] ?? '', 'member-0')).resolves.toBeNull();
    await expect(
      redis.zscore(keys[3] ?? '', 'member-4'),
    ).resolves.not.toBeNull();
  });

  it('counts a key dropped at the cap as a first attempt, not a repeat', async () => {
    const keys = scriptKeys(`org_${randomUUID()}`, `ak_${randomUUID()}`);

    for (let index = 0; index < 4; index += 1) {
      await run(keys, `member-${index}`, `req-${index}`, 3);
    }
    const [result] = await run(keys, 'member-0', 'req-again', 3);

    expect(result).toBe(0);
    await expect(redis.zcard(keys[2] ?? '')).resolves.toBe(0);
    await expect(redis.zcard(keys[1] ?? '')).resolves.toBe(5);
  });

  it('forgets attempts older than the 60-second window', async () => {
    const keys = scriptKeys(`org_${randomUUID()}`, `ak_${randomUUID()}`);
    const now = Date.now();
    const old = now - 10 * 60_000;
    // The key is already seen, with one first attempt in the window and one
    // repeat that has aged out of it.
    await redis.zadd(keys[3] ?? '', now + 86_400_000, 'seen-member');
    await redis.zadd(keys[1] ?? '', now, 'first-attempt');
    await redis.zadd(keys[2] ?? '', old, 'aged-repeat');

    const [result] = await run(keys, 'seen-member', 'req-repeat');

    expect(result).toBe(0);
    await expect(
      redis.zscore(keys[2] ?? '', 'aged-repeat'),
    ).resolves.toBeNull();
  });

  it('refuses the same repeat while the earlier repeat is still inside the window', async () => {
    const keys = scriptKeys(`org_${randomUUID()}`, `ak_${randomUUID()}`);
    const now = Date.now();
    await redis.zadd(keys[3] ?? '', now + 86_400_000, 'seen-member');
    await redis.zadd(keys[1] ?? '', now, 'first-attempt');
    await redis.zadd(keys[2] ?? '', now, 'recent-repeat');

    const [result] = await run(keys, 'seen-member', 'req-repeat');

    expect(result).toBe(2);
  });
});
