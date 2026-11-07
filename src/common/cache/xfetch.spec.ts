import { XFetchCache } from './xfetch';

interface TestClock {
  now: number;
}

function createClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  const state: TestClock = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
  };
}

describe('XFetchCache', () => {
  it('serves a fresh cache hit without re-fetching', async () => {
    const clock = createClock();
    let loadCount = 0;
    const cache = new XFetchCache<string, string>(
      async () => {
        loadCount += 1;
        clock.advance(20);
        return 'rubric-v1';
      },
      { now: clock.now, ttlMs: 1000 },
    );

    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    clock.advance(500);
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    expect(loadCount).toBe(1);
  });

  it('reloads synchronously once the entry is truly expired', async () => {
    const clock = createClock();
    const values = ['rubric-v1', 'rubric-v2'];
    let loadCount = 0;
    const cache = new XFetchCache<string, string>(
      async () => {
        const value = values[loadCount] ?? 'missing';
        loadCount += 1;
        clock.advance(20);
        return value;
      },
      { now: clock.now, ttlMs: 1000 },
    );

    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    clock.advance(1000);
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v2');
    expect(loadCount).toBe(2);
  });

  it('serves the stale value and refreshes in the background near expiry', async () => {
    const clock = createClock();
    const values = ['rubric-v1', 'rubric-v2'];
    let loadCount = 0;
    const cache = new XFetchCache<string, string>(
      async () => {
        const value = values[loadCount] ?? 'missing';
        loadCount += 1;
        clock.advance(20);
        return value;
      },
      { now: clock.now, ttlMs: 1000, random: () => 0.5 },
    );

    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    // delta = 20ms, random 0.5: early-refresh budget is ~13.86ms, so a
    // remaining lifetime of 10ms must trigger the background refresh.
    clock.advance(990);
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    expect(loadCount).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(loadCount).toBe(2);
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v2');
    expect(loadCount).toBe(2);
  });

  it('keeps serving the stale value when the background refresh fails', async () => {
    const clock = createClock();
    let loadCount = 0;
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const cache = new XFetchCache<string, string>(
      async () => {
        loadCount += 1;
        clock.advance(20);
        if (loadCount === 2) {
          throw new Error('postgres down');
        }
        return 'rubric-v1';
      },
      { now: clock.now, ttlMs: 1000, random: () => 0.5 },
    );

    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    clock.advance(990);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loadCount).toBe(2);
      await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
      expect(loadCount).toBe(3);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
    expect(unhandledRejections).toEqual([]);
  });

  it('dispatches exactly one refresh for 100 parallel readers near expiry', async () => {
    const clock = createClock();
    const values = ['rubric-v1', 'rubric-v2'];
    let loadCount = 0;
    const cache = new XFetchCache<string, string>(
      async () => {
        const value = values[loadCount] ?? 'missing';
        loadCount += 1;
        clock.advance(20);
        return value;
      },
      // random() -> 0 clamps to ~0: the early-refresh budget always exceeds
      // the remaining lifetime, so every reader wants the refresh.
      { now: clock.now, ttlMs: 1000, random: () => 0 },
    );

    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v1');
    clock.advance(990);

    const readers = Array.from({ length: 100 }, () =>
      cache.get('active-rubric'),
    );
    await expect(Promise.all(readers)).resolves.toEqual(
      Array.from({ length: 100 }, () => 'rubric-v1'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(loadCount).toBe(2);
    await expect(cache.get('active-rubric')).resolves.toBe('rubric-v2');
    expect(loadCount).toBe(2);
  });
});
