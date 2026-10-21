import { AppError } from '@/common/errors/app-error';
import type { GradedAdmissionRequest } from '@/modules/gateway/application/graded-admission.port';
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
  failure: Error | undefined;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    this.calls.push({ script, numberOfKeys, args });
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }

  async quit(): Promise<void> {}
}

const request: GradedAdmissionRequest = {
  apiKeyId: 'ak_1',
  rateLimitRpm: 60,
  organizationId: 'org_1',
  requestId: 'req_1',
  operation: 'writing.task1.grade',
  idempotencyKey: 'same-key',
  monthlyRequestQuota: 100,
};

describe('RedisGradedAdmission', () => {
  it('runs rate, retry-budget, and quota admission in one ordered script', async () => {
    const redis = new FakeRedis();
    const admission = new RedisGradedAdmission(redis, () => 1_782_000_000_000);

    await expect(admission.consume(request)).resolves.toEqual({
      stage: 'admitted',
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
      'aihub:v1:rl:ak_1:29700000',
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
        () => 1_782_000_000_000,
        () => 0.25,
      ).consume(request),
    ).resolves.toMatchObject({ stage });
  });

  it('does not run retry-budget or quota checks for an unkeyed, unlimited request', async () => {
    const redis = new FakeRedis();

    await new RedisGradedAdmission(redis, () => 1_782_000_000_000).consume({
      apiKeyId: request.apiKeyId,
      rateLimitRpm: request.rateLimitRpm,
      organizationId: request.organizationId,
      requestId: request.requestId,
      operation: 'speaking.grading',
      monthlyRequestQuota: null,
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
