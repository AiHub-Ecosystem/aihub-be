import { AppError } from '@/common/errors/app-error';
import type { GradedAdmissionRequest } from '@/modules/gateway/application/graded-admission.port';
import { rateLimitWindow } from '@/modules/gateway/application/rate-limit-window';
import {
  GRADED_ADMISSION_SCRIPT,
  RedisGradedAdmission,
  type RedisGradedAdmissionClient,
} from './redis-graded-admission';

class FakeRedis implements RedisGradedAdmissionClient {
  readonly calls: {
    script: string;
    numberOfKeys: number;
    args: readonly (string | number)[];
  }[] = [];
  result = 0;
  /** The per-key count the script reports alongside its result. */
  rateCount = 1;
  /** Results for the next calls, before falling back to `result`. */
  queued: number[] = [];
  failure: Error | undefined;

  async evalNumbers(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<readonly number[]> {
    this.calls.push({ script, numberOfKeys, args });
    if (this.failure !== undefined) throw this.failure;
    return [this.queued.shift() ?? this.result, this.rateCount];
  }

  async quit(): Promise<void> {}
}

const NOW = 1_782_000_000_000;

const request: GradedAdmissionRequest = {
  apiKeyId: 'ak_1',
  rateLimitRpm: 60,
  organizationId: 'org_1',
  requestId: 'req_1',
  operation: 'writing.task1.grade',
  idempotencyKey: 'same-key',
  monthlyRequestQuota: 100,
  hardStopOnQuota: false,
};

describe('RedisGradedAdmission', () => {
  it('runs rate, retry-budget, and quota admission in one ordered script', async () => {
    const redis = new FakeRedis();
    const admission = new RedisGradedAdmission(redis, () => NOW);

    await expect(admission.consume(request)).resolves.toEqual({
      stage: 'admitted',
      rate: {
        limit: 60,
        remaining: 59,
        resetInMs: rateLimitWindow('ak_1', NOW).resetInMs,
      },
    });

    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0]).toMatchObject({
      script: GRADED_ADMISSION_SCRIPT,
      numberOfKeys: 5,
    });
    const script = redis.calls[0]?.script ?? '';
    expect(script.indexOf("redis.call('INCR'")).toBeLessThan(
      script.indexOf("redis.call('ZREMRANGEBYSCORE'"),
    );
    expect(script.indexOf("redis.call('ZADD'")).toBeLessThan(
      script.indexOf("redis.call('GET'"),
    );
    expect(redis.calls[0]?.args.slice(0, 5)).toEqual([
      `aihub:v1:rl:ak_1:${rateLimitWindow('ak_1', NOW).index}`,
      expect.stringMatching(/^aihub:v1:org-retry:\{[0-9a-f]{64}\}:first$/),
      expect.stringMatching(/^aihub:v1:org-retry:\{[0-9a-f]{64}\}:repeats$/),
      expect.stringMatching(/^aihub:v1:org-retry:\{[0-9a-f]{64}\}:seen$/),
      'aihub:v1:quota:org_1:2026-06',
    ]);
    expect(redis.calls[0]?.args.slice(5)).toEqual([
      '60',
      '1',
      expect.any(String),
      'req_1',
      '10000',
      '100',
    ]);
  });

  it.each([
    [1, 'rate_limit'],
    [2, 'retry_budget'],
    [3, 'quota'],
  ] as const)('maps verified policy result %i to %s', async (result, stage) => {
    const redis = new FakeRedis();
    redis.result = result;

    await expect(
      new RedisGradedAdmission(
        redis,
        () => NOW,
        () => 0.25,
      ).consume(request),
    ).resolves.toMatchObject({ stage });
  });

  it('reports what is left of the per-key window, never below zero', async () => {
    const redis = new FakeRedis();
    redis.result = 1;
    redis.rateCount = 61;

    await expect(
      new RedisGradedAdmission(redis, () => NOW).consume(request),
    ).resolves.toMatchObject({ rate: { limit: 60, remaining: 0 } });
  });

  it('tells rate-limited callers refused in the same millisecond different instants, never before the window resets', async () => {
    const redis = new FakeRedis();
    redis.result = 1;
    const admission = new RedisGradedAdmission(redis, () => NOW);
    const { resetInMs } = rateLimitWindow('ak_1', NOW);

    const hints = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const decision = await admission.consume(request);
        return decision.stage === 'rate_limit' ? decision.retryAfterMs : -1;
      }),
    );

    expect(new Set(hints).size).toBeGreaterThan(1);
    for (const hint of hints) {
      expect(hint).toBeGreaterThanOrEqual(resetInMs);
      expect(hint).toBeLessThan(resetInMs + 1_000);
    }
  });

  it('does not run retry-budget or quota checks for an unkeyed, unlimited request', async () => {
    const redis = new FakeRedis();

    await new RedisGradedAdmission(redis, () => NOW).consume({
      apiKeyId: request.apiKeyId,
      rateLimitRpm: request.rateLimitRpm,
      organizationId: request.organizationId,
      requestId: request.requestId,
      operation: 'speaking.grading',
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
    });

    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0]?.args.slice(5)).toEqual([
      '60',
      '0',
      '',
      'req_1',
      '10000',
      '',
    ]);
  });

  it('reports an ambiguous Redis mutation as a retryable unavailable 503', async () => {
    const redis = new FakeRedis();
    redis.failure = new Error('command timed out');
    const admission = new RedisGradedAdmission(redis);

    await expect(admission.consume(request)).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      retryAfterMs: 1_000,
    });
    expect(redis.calls).toHaveLength(1);
  });

  it('checks the quota counter exists before the script writes anything', () => {
    const exists = GRADED_ADMISSION_SCRIPT.indexOf("redis.call('EXISTS'");
    expect(exists).toBeGreaterThan(-1);
    expect(exists).toBeLessThan(GRADED_ADMISSION_SCRIPT.indexOf("'INCR'"));
  });

  it('rebuilds a missing quota counter from durable usage, then admits through the quota check', async () => {
    const redis = new FakeRedis();
    redis.queued = [5, 0];
    const seed = jest.fn(async () => undefined);
    const admission = new RedisGradedAdmission(
      redis,
      () => NOW,
      Math.random,
      undefined,
      { seed },
    );

    await expect(admission.consume(request)).resolves.toMatchObject({
      stage: 'admitted',
    });
    expect(seed).toHaveBeenCalledWith('org_1', new Date(NOW));
    expect(redis.calls).toHaveLength(2);
    expect(redis.calls[1]?.args).toEqual(redis.calls[0]?.args);
  });

  it.each([
    [
      'the rebuild fails',
      { seed: async () => Promise.reject(new Error('db down')) },
    ],
    ['no durable source is configured', undefined],
  ])(
    'admits without the quota check and marks it unverified when %s',
    async (_name, seeder) => {
      const redis = new FakeRedis();
      redis.queued = [5, 0];
      const admission = new RedisGradedAdmission(
        redis,
        () => NOW,
        Math.random,
        undefined,
        seeder,
      );

      await expect(admission.consume(request)).resolves.toMatchObject({
        stage: 'admitted',
        quotaUnverified: true,
      });
      expect(redis.calls).toHaveLength(2);
      expect(redis.calls[1]?.args.at(-1)).toBe('');
    },
  );

  it('refuses a hard-stop Organization with a retryable 503 when the lost counter cannot be rebuilt', async () => {
    const redis = new FakeRedis();
    redis.queued = [5];
    const admission = new RedisGradedAdmission(
      redis,
      () => NOW,
      Math.random,
      undefined,
      { seed: async () => Promise.reject(new Error('db down')) },
    );

    await expect(
      admission.consume({ ...request, hardStopOnQuota: true }),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryAfterMs: 1_000,
    });
    expect(redis.calls).toHaveLength(1);
  });

  it('fails unavailable when no Redis client is configured', async () => {
    await expect(
      new RedisGradedAdmission(undefined).consume(request),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      retryable: true,
      retryAfterMs: 1_000,
    } satisfies Partial<AppError>);
  });
});
