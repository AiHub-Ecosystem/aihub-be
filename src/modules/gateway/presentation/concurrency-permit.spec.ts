import type { ConcurrencyLease } from '@/modules/gateway/application/concurrency-limiter.port';
import { createConcurrencyPermit } from './concurrency-permit';

describe('createConcurrencyPermit', () => {
  it('releases once when the HTTP request finishes', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const permit = createConcurrencyPermit({ release });

    await permit.requestFinished();
    await permit.requestFinished();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for handler settlement after an early response close', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const permit = createConcurrencyPermit({ release });

    await permit.responseFinished();
    expect(release).not.toHaveBeenCalled();

    await permit.requestFinished();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds a permit for idempotency background work until both lifecycles settle', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const permit = createConcurrencyPermit({ release });

    permit.holdForBackground();
    await permit.requestFinished();
    expect(release).not.toHaveBeenCalled();

    await permit.backgroundFinished();
    expect(release).toHaveBeenCalledTimes(1);
    await permit.backgroundFinished();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when background work settles before the response', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const permit = createConcurrencyPermit({ release });

    permit.holdForBackground();
    await permit.backgroundFinished();
    expect(release).not.toHaveBeenCalled();

    await permit.requestFinished();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
