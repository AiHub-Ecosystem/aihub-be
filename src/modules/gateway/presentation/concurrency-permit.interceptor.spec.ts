import { EventEmitter } from 'node:events';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';

import { getMetrics } from '@/common/observability/metrics';
import type {
  ConcurrencyLease,
  ConcurrencyLimiterPort,
} from '@/modules/gateway/application/concurrency-limiter.port';
import { ConcurrencyPermitInterceptor } from './concurrency-permit.interceptor';

const authenticated = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  maxConcurrent: 20,
  environment: 'production',
};

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

function allowingLimiter(release: jest.Mock): ConcurrencyLimiterPort {
  return {
    acquire: async () => ({ allowed: true, lease: { release } }),
  };
}

async function rejectedConcurrencyCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="concurrency"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('ConcurrencyPermitInterceptor', () => {
  it('acquires a lease from the authenticated request and releases it once', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const acquire = jest.fn<ReturnType<ConcurrencyLimiterPort['acquire']>, []>(
      async () => ({ allowed: true, lease: { release } }),
    );
    const interceptor = new ConcurrencyPermitInterceptor({ acquire });
    const raw = new EventEmitter();
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYINTERCEPT000000',
      aihubAuth: authenticated,
    };

    const next: CallHandler = { handle: () => of('ok') };
    const observable = await interceptor.intercept(
      contextFor(request, { raw }),
      next,
    );
    await firstValueFrom(observable);

    expect(acquire).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      maxConcurrent: 20,
      requestId: 'req_01JCONCURRENCYINTERCEPT000000',
      environment: 'production',
    });
    expect(request.aihubConcurrency).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('maps a denied lease to CONCURRENCY_LIMIT', async () => {
    const before = await rejectedConcurrencyCount();
    const acquire: ConcurrencyLimiterPort['acquire'] = async () => ({
      allowed: false,
      retryAfterMs: 500,
    });
    const interceptor = new ConcurrencyPermitInterceptor({ acquire });
    const raw = new EventEmitter();
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYDENIED0000000',
      aihubAuth: authenticated,
    };
    const next: CallHandler = { handle: () => of('ok') };

    await expect(
      interceptor.intercept(contextFor(request, { raw }), next),
    ).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 500,
    });
    expect(await rejectedConcurrencyCount()).toBe(before + 1);
  });

  it('waits for handler settlement after an early response close', async () => {
    const raw = new EventEmitter();
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const interceptor = new ConcurrencyPermitInterceptor(
      allowingLimiter(release),
    );
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYEARLYCLOSE00000',
      aihubAuth: authenticated,
    };
    const subject = new Subject<unknown>();
    const next: CallHandler = { handle: () => subject.asObservable() };

    const observable = await interceptor.intercept(
      contextFor(request, { raw }),
      next,
    );
    const completion = firstValueFrom(observable).catch(() => undefined);

    raw.emit('close');
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    subject.complete();
    await completion;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases when the handler errors', async () => {
    const raw = new EventEmitter();
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => undefined,
    );
    const interceptor = new ConcurrencyPermitInterceptor(
      allowingLimiter(release),
    );
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYERROR00000000',
      aihubAuth: authenticated,
    };
    const subject = new Subject<unknown>();
    const next: CallHandler = { handle: () => subject.asObservable() };

    const observable = await interceptor.intercept(
      contextFor(request, { raw }),
      next,
    );
    const completion = firstValueFrom(observable).catch(() => undefined);
    subject.error(new Error('handler failed'));
    await completion;

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves a successful handler result when permit release fails', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => {
        throw new Error('redis timeout');
      },
    );
    const interceptor = new ConcurrencyPermitInterceptor(
      allowingLimiter(release),
    );
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYRELEASEFAIL00000',
      aihubAuth: authenticated,
    };

    const observable = await interceptor.intercept(
      contextFor(request, { raw: new EventEmitter() }),
      { handle: () => of('graded') },
    );

    await expect(firstValueFrom(observable)).resolves.toBe('graded');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves the handler error when permit release also fails', async () => {
    const release = jest.fn<ReturnType<ConcurrencyLease['release']>, []>(
      async () => {
        throw new Error('redis timeout');
      },
    );
    const interceptor = new ConcurrencyPermitInterceptor(
      allowingLimiter(release),
    );
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYHANDLERRELEASE000',
      aihubAuth: authenticated,
    };
    const handlerError = new Error('handler failed');

    const observable = await interceptor.intercept(
      contextFor(request, { raw: new EventEmitter() }),
      { handle: () => throwError(() => handlerError) },
    );

    await expect(firstValueFrom(observable)).rejects.toBe(handlerError);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
