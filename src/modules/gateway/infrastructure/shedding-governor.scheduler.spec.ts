import type { DownstreamConcurrencySample } from './dispatch/downstream-concurrency-metrics';
import { SheddingGovernorScheduler } from './shedding-governor.scheduler';
import {
  SHEDDING_LEVEL_KEY,
  type SheddingLevelRedisClient,
  SheddingLevelStore,
} from './shedding-level.store';

/** A level store backed by an in-memory key, so the pass is tested end to end. */
class FakeRedis implements SheddingLevelRedisClient {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  eval(
    _script: string,
    _numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    const key = String(args[0]);
    const next = Math.max(Number(this.values.get(key) ?? 0), Number(args[1]));
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }
}

function sample(
  origin: string,
  inFlight: number,
  limit: number,
): DownstreamConcurrencySample {
  return { origin, inFlight, limit, rttMinMs: 10, rttAvgMs: 20 };
}

const noLogger = { warn: () => undefined, log: () => undefined };

/** Lets the pass's own Redis read and its `.then` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SheddingGovernorScheduler', () => {
  it('sheds from the peak origin utilization and publishes it', async () => {
    const redis = new FakeRedis();
    const level = new SheddingLevelStore(redis, noLogger);
    const scheduler = new SheddingGovernorScheduler(
      () => [sample('ai-writing', 5, 10), sample('ai-speaking', 9, 10)],
      level,
      () => 0,
    );

    scheduler.runPass();
    await settle();

    expect(level.current()).toBe(1);
    expect(redis.values.get(SHEDDING_LEVEL_KEY)).toBe('1');
  });

  it('reports the applied level, including a peer level it did not decide', async () => {
    const metrics = await import('@/common/observability/metrics');
    const redis = new FakeRedis();
    redis.values.set(SHEDDING_LEVEL_KEY, '2');
    const level = new SheddingLevelStore(redis, noLogger);
    const scheduler = new SheddingGovernorScheduler(
      () => [sample('ai-writing', 0, 10)],
      level,
      () => 0,
    );

    scheduler.runPass();
    await settle();

    expect(await metrics.getMetrics()).toContain('aihub_shed_level 2');
  });

  it('ignores an origin with no live limit instead of dividing by zero', () => {
    const level = new SheddingLevelStore(undefined, noLogger);
    const scheduler = new SheddingGovernorScheduler(
      () => [sample('ai-writing', 7, 0)],
      level,
      () => 0,
    );

    scheduler.runPass();

    expect(level.current()).toBe(0);
  });
});
