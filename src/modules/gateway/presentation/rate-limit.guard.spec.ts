import type { ExecutionContext } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { GradedAdmissionPort } from '@/modules/gateway/application/graded-admission.port';
import type { RateLimiterPort } from '@/modules/gateway/application/rate-limiter.port';
import { RateLimitGuard } from './rate-limit.guard';

const authenticated = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: 5,
  hardStopOnQuota: false,
  allowedEnvironments: ['production'],
} as const;

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function requestFor(
  operation: keyof typeof OPERATION_CATALOG,
): Record<string, unknown> {
  return {
    id: 'req_01JGRADINGADMISSION0000000000',
    raw: {},
    headers: {},
    aihubAuth: authenticated,
    routeOptions: { url: OPERATION_CATALOG[operation].path },
    aihubIdentity: { mode: 'declared_id' },
    aihubMetering: {
      operation,
      organizationId: authenticated.organizationId,
      apiKeyId: authenticated.apiKeyId,
      environment: authenticated.environment,
      settled: false,
    },
  };
}

describe('RateLimitGuard', () => {
  it.each([
    'writing.task1.grade',
    'writing.task2.grade',
    'speaking.grading',
    'speaking.grading-json',
  ] as const)('uses graded admission for %s', async (operation) => {
    const consume = jest.fn<
      ReturnType<GradedAdmissionPort['consume']>,
      Parameters<GradedAdmissionPort['consume']>
    >(async () => ({ stage: 'admitted' }));
    const rateConsume = jest.fn<
      ReturnType<RateLimiterPort['consume']>,
      Parameters<RateLimiterPort['consume']>
    >(async () => ({ allowed: true }));
    const request = requestFor(operation);
    const guard = new RateLimitGuard({ consume: rateConsume }, { consume });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith({
      apiKeyId: authenticated.apiKeyId,
      rateLimitRpm: authenticated.rateLimitRpm,
      organizationId: authenticated.organizationId,
      requestId: 'req_01JGRADINGADMISSION0000000000',
      operation,
      monthlyRequestQuota: authenticated.monthlyRequestQuota,
    });
    expect(rateConsume).not.toHaveBeenCalled();
  });

  it('keeps metered upload routes on the ordinary rate limiter', async () => {
    const rateConsume = jest.fn<
      ReturnType<RateLimiterPort['consume']>,
      Parameters<RateLimiterPort['consume']>
    >(async () => ({ allowed: true }));
    const request = requestFor('writing.task1.grade');
    request.routeOptions = {
      url: PUBLIC_ROUTES['writing.chartUploads.create'].path,
    };
    const guard = new RateLimitGuard({ consume: rateConsume });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(rateConsume).toHaveBeenCalledWith({
      keyId: authenticated.apiKeyId,
      limit: authenticated.rateLimitRpm,
    });
  });

  it('fails closed when graded admission is not wired', async () => {
    const guard = new RateLimitGuard({
      consume: async () => ({ allowed: true }),
    });

    await expect(
      guard.canActivate(contextFor(requestFor('writing.task1.grade'))),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });
});
