import type { ExecutionContext } from '@nestjs/common';

import type {
  ConcurrencyLease,
  ConcurrencyLimiterPort,
} from '../application/concurrency-limiter.port';
import { ConcurrencyGuard } from './concurrency.guard';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

const authenticated = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  maxConcurrent: 20,
};

describe('ConcurrencyGuard', () => {
  it('acquires an organization lease from the authenticated request', async () => {
    const lease: ConcurrencyLease = { release: jest.fn(async () => undefined) };
    const acquire = jest.fn<ReturnType<ConcurrencyLimiterPort['acquire']>, []>(
      async () => ({ allowed: true, lease }),
    );
    const guard = new ConcurrencyGuard({ acquire });
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYGUARD0000000000',
      aihubAuth: authenticated,
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(acquire).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      maxConcurrent: 20,
      requestId: 'req_01JCONCURRENCYGUARD0000000000',
    });
    expect(request.aihubConcurrency).toBeDefined();
  });

  it('maps a denied lease to CONCURRENCY_LIMIT', async () => {
    const acquire: ConcurrencyLimiterPort['acquire'] = async () => ({
      allowed: false,
      retryAfterMs: 500,
    });
    const guard = new ConcurrencyGuard({ acquire });
    const request: Record<string, unknown> = {
      id: 'req_01JCONCURRENCYDENIED000000000',
      aihubAuth: authenticated,
    };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 500,
    });
  });
});
