import { EventEmitter } from 'node:events';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Subject } from 'rxjs';

import type { ConcurrencyLease } from '../application/concurrency-limiter.port';
import { createConcurrencyPermit } from './concurrency-permit';
import { ConcurrencyReleaseInterceptor } from './concurrency-release.interceptor';

function contextFor(
  request: Record<string, unknown>,
  reply: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as ExecutionContext;
}

describe('ConcurrencyReleaseInterceptor', () => {
  it('waits for handler settlement after an early response close', async () => {
    const raw = new EventEmitter();
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const request = {
      aihubConcurrency: createConcurrencyPermit({ release }),
    };
    const subject = new Subject<unknown>();
    const next: CallHandler = { handle: () => subject.asObservable() };
    const interceptor = new ConcurrencyReleaseInterceptor();
    const subscription = interceptor
      .intercept(contextFor(request, { raw }), next)
      .subscribe();

    raw.emit('close');
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    subject.complete();
    subscription.unsubscribe();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when the handler errors', async () => {
    const raw = new EventEmitter();
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const request = {
      aihubConcurrency: createConcurrencyPermit({ release }),
    };
    const subject = new Subject<unknown>();
    const next: CallHandler = { handle: () => subject.asObservable() };
    const interceptor = new ConcurrencyReleaseInterceptor();

    interceptor
      .intercept(contextFor(request, { raw }), next)
      .subscribe({ error: () => undefined });
    subject.error(new Error('handler failed'));
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
