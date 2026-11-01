import { Singleflight } from './singleflight';

describe('Singleflight', () => {
  it('runs one lookup for 100 concurrent requests with the same key', async () => {
    const singleflight = new Singleflight<string, string>();
    let queryCount = 0;
    let releaseQuery: ((value: string) => void) | undefined;
    let markQueryStarted: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    const query = new Promise<string>((resolve) => {
      releaseQuery = resolve;
    });
    const load = (): Promise<string> => {
      queryCount += 1;
      markQueryStarted?.();
      return query;
    };

    const requests = Array.from({ length: 100 }, () =>
      singleflight.run('active-rubric', load),
    );
    await queryStarted;

    expect(queryCount).toBe(1);
    releaseQuery?.('rubric-v1');
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 100 }, () => 'rubric-v1'),
    );
    await expect(singleflight.run('active-rubric', load)).resolves.toBe(
      'rubric-v1',
    );
    expect(queryCount).toBe(2);
  });

  it('propagates a failure to waiters and allows a later retry', async () => {
    const singleflight = new Singleflight<string, string>();
    const failure = new Error('lookup failed');
    let rejectQuery: ((reason: Error) => void) | undefined;
    let markQueryStarted: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    const query = new Promise<string>((_resolve, reject) => {
      rejectQuery = reject;
    });
    let loadCalls = 0;
    const load = (): Promise<string> => {
      loadCalls += 1;
      if (loadCalls === 1) {
        markQueryStarted?.();
        return query;
      }
      return Promise.resolve('ok');
    };
    const first = singleflight.run('active-rubric', load);
    await queryStarted;
    const waiters = Array.from({ length: 99 }, () =>
      singleflight.run('active-rubric', load),
    );

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      rejectQuery?.(failure);
      const rejected = await Promise.allSettled([first, ...waiters]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejected).toHaveLength(100);
      expect(rejected.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      let sameFailureCount = 0;
      for (const result of rejected) {
        if (result.status === 'rejected' && result.reason === failure) {
          sameFailureCount += 1;
        }
      }
      expect(sameFailureCount).toBe(100);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    await expect(singleflight.run('active-rubric', load)).resolves.toBe('ok');
    expect(loadCalls).toBe(2);
  });
});
