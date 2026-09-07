import { Logger } from '@nestjs/common';
import type { IdempotencyRepositoryPort } from '../application/idempotency-repository.port';
import { IdempotencyCleanupScheduler } from './idempotency-cleanup.scheduler';

class FakeRepository implements IdempotencyRepositoryPort {
  cleanupCalls = 0;
  shouldFail = false;

  reserve(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  complete(): Promise<void> {
    return Promise.resolve();
  }

  markFailed(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  async cleanupExpired(): Promise<number> {
    this.cleanupCalls += 1;
    if (this.shouldFail) {
      throw new Error('database unavailable');
    }
    return 1;
  }
}

describe('IdempotencyCleanupScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cleans expired records hourly and clears its timer on shutdown', async () => {
    const repository = new FakeRepository();
    const scheduler = new IdempotencyCleanupScheduler(repository);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(repository.cleanupCalls).toBe(1);

    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(repository.cleanupCalls).toBe(1);
  });

  it('warns and keeps the timer alive when cleanup fails', async () => {
    const repository = new FakeRepository();
    repository.shouldFail = true;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const scheduler = new IdempotencyCleanupScheduler(repository);

    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(repository.cleanupCalls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    scheduler.onModuleDestroy();
  });
});
