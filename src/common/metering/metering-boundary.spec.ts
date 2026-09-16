import { firstValueFrom, of } from 'rxjs';

import { AppError } from '../errors/app-error';
import { HttpExceptionFilter } from '../errors/http-exception.filter';
import { SuccessEnvelopeInterceptor } from '../http/success-envelope.interceptor';
import type {
  MeteringFinalizeInput,
  MeteringFinalizerPort,
} from './metering-finalizer.port';
import {
  initializeRequestMetering,
  setRequestMeteringIdentity,
  setRequestMeteringQuotaTracked,
  setRequestMeteringQuotaUnverified,
} from './request-metering-state';

function contextFor(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): Parameters<SuccessEnvelopeInterceptor['intercept']>[0] {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as Parameters<SuccessEnvelopeInterceptor['intercept']>[0];
}

class FakeFinalizer implements MeteringFinalizerPort {
  readonly inputs: MeteringFinalizeInput[] = [];

  async finalize(input: MeteringFinalizeInput): Promise<void> {
    this.inputs.push(input);
  }
}

function authenticatedRequest(
  quotaTracked = false,
  quotaUnverified = false,
): Record<string, unknown> {
  const request = {
    id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    headers: {},
  };
  initializeRequestMetering(request, new Date(), 0);
  setRequestMeteringIdentity(request, {
    operation: 'writing.task1.grade',
    organizationId: 'org_acme',
    apiKeyId: 'ak_backend',
    environment: 'production',
  });
  if (quotaTracked) {
    setRequestMeteringQuotaTracked(request, true);
  }
  if (quotaUnverified) {
    setRequestMeteringQuotaUnverified(request);
  }
  return request;
}

describe('metering request boundary', () => {
  it('awaits a successful metering write before emitting the public envelope', async () => {
    const finalizer = new FakeFinalizer();
    const request = authenticatedRequest();
    const interceptor = new SuccessEnvelopeInterceptor(finalizer);

    const envelope = await firstValueFrom(
      interceptor.intercept(contextFor(request, { header: () => undefined }), {
        handle: () =>
          of({
            operation: 'writing.task1.grade',
            data: { band: 7 },
            downstreamMs: 80,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }),
      }),
    );

    expect(envelope.data).toEqual({ band: 7 });
    expect(envelope.meta).not.toHaveProperty('usage');
    expect(envelope.meta).not.toHaveProperty('models');
    expect(finalizer.inputs).toHaveLength(1);
    expect(finalizer.inputs[0]).toEqual(
      expect.objectContaining({
        requestId: request.id,
        outcome: 'success',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
    );
  });

  it('records a post-auth error once and leaves the public error unchanged', async () => {
    const finalizer = new FakeFinalizer();
    const request = authenticatedRequest();
    const send = jest.fn();
    const filter = new HttpExceptionFilter(finalizer);
    const context = contextFor(request, { status: () => ({ send }) });
    const error = new AppError({
      code: 'AI_SERVICE_TIMEOUT',
      message: 'AI service request timed out',
      retryable: true,
    });

    await filter.catch(error, context);
    await filter.catch(error, context);

    expect(finalizer.inputs).toHaveLength(1);
    expect(finalizer.inputs[0]).toEqual(
      expect.objectContaining({
        outcome: 'downstream_error',
        httpStatus: 504,
        errorCode: 'AI_SERVICE_TIMEOUT',
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].error).toEqual(
      expect.objectContaining({ code: 'AI_SERVICE_TIMEOUT' }),
    );
  });

  it('passes quota tracking state to the finalizer', async () => {
    const finalizer = new FakeFinalizer();
    const request = authenticatedRequest(true);
    const interceptor = new SuccessEnvelopeInterceptor(finalizer);

    await firstValueFrom(
      interceptor.intercept(contextFor(request, { header: () => undefined }), {
        handle: () =>
          of({
            operation: 'writing.task1.grade',
            data: { band: 7 },
            downstreamMs: 80,
          }),
      }),
    );

    expect(finalizer.inputs[0]).toEqual(
      expect.objectContaining({ quotaTracked: true }),
    );
  });

  it('passes quota-unverified state through error metering', async () => {
    const finalizer = new FakeFinalizer();
    const request = authenticatedRequest(true, true);
    const filter = new HttpExceptionFilter(finalizer);
    const context = contextFor(request, {
      status: () => ({ send: jest.fn() }),
    });

    await filter.catch(
      new AppError({
        code: 'INVALID_REQUEST',
        message: 'Request failed validation',
        retryable: false,
      }),
      context,
    );

    expect(finalizer.inputs[0]).toEqual(
      expect.objectContaining({
        quotaTracked: true,
        quotaUnverified: true,
      }),
    );
  });
});
