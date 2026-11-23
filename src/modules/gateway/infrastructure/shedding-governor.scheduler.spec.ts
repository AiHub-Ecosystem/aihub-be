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

  waitUntilReady(_signal: AbortSignal): Promise<boolean> {
    return Promise.resolve(true);
  }

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
    const metrics = await import('@/common/observability/metrics/metrics');
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

  it('waits for the initial Redis connection before polling its shared level', async () => {
    jest.useFakeTimers();
    let resolveReady: ((ready: boolean) => void) | undefined;
    let scheduler: SheddingGovernorScheduler | undefined;
    try {
      const redis = new FakeRedis();
      jest.spyOn(redis, 'waitUntilReady').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveReady = resolve;
          }),
      );
      const snapshot = jest.fn(() => [sample('ai-writing', 0, 10)]);
      scheduler = new SheddingGovernorScheduler(
        snapshot,
        new SheddingLevelStore(redis, noLogger),
        () => 0,
      );

      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(snapshot).not.toHaveBeenCalled();

      resolveReady?.(true);
      await jest.advanceTimersByTimeAsync(0);
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      resolveReady?.(false);
      await scheduler?.beforeApplicationShutdown();
      jest.useRealTimers();
    }
  });

  it('waits for in-flight Redis work before application shutdown completes', async () => {
    let resolveRead!: (value: string | null) => void;
    const redis = new FakeRedis();
    jest.spyOn(redis, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const scheduler = new SheddingGovernorScheduler(
      () => [sample('ai-writing', 0, 10)],
      new SheddingLevelStore(redis, noLogger),
      () => 0,
    );
    scheduler.runPass();

    let stopped = false;
    const shutdown = scheduler
      .beforeApplicationShutdown()
      .then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveRead(null);
    await shutdown;
    expect(stopped).toBe(true);
  });

  it('stops sampling once the application shuts down', async () => {
    jest.useFakeTimers();
    try {
      const snapshot = jest.fn(() => [sample('ai-writing', 9, 10)]);
      const scheduler = new SheddingGovernorScheduler(
        snapshot,
        new SheddingLevelStore(undefined, noLogger),
        () => 0,
      );

      scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenCalled();

      await scheduler.beforeApplicationShutdown();
      snapshot.mockClear();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(snapshot).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
