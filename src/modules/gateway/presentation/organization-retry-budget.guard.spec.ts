import type { ExecutionContext } from '@nestjs/common';

import type { OrganizationRetryBudgetPort } from '@/modules/gateway/application/organization-retry-budget.port';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import type { MeteringEvidence } from '@/modules/metering/application/metering-evidence';
import { OrganizationRetryBudgetGuard } from './organization-retry-budget.guard';

const authenticated: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: 5,
  hardStopOnQuota: false,
  allowedEnvironments: ['production'],
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function requestFor(
  operation: MeteringEvidence['operation'],
  key?: string,
): Record<string, unknown> {
  return {
    id: 'req_123',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    aihubAuth: authenticated,
    aihubMetering: {
      operation,
      organizationId: authenticated.organizationId,
      apiKeyId: authenticated.apiKeyId,
      environment: authenticated.environment,
      settled: false,
    } satisfies MeteringEvidence,
  };
}

describe('OrganizationRetryBudgetGuard', () => {
  it('counts a same-key eligible request before quota admission', async () => {
    const consume = jest.fn().mockResolvedValue({ allowed: true });
    const budget: OrganizationRetryBudgetPort = { consume };
    const request = requestFor('writing.task1.grade', ' retry-1 ');

    await expect(
      new OrganizationRetryBudgetGuard(budget).canActivate(contextFor(request)),
    ).resolves.toBe(true);

    expect(consume).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      operation: 'writing.task1.grade',
      idempotencyKey: 'retry-1',
      requestId: 'req_123',
    });
  });

  it('returns a retryable 429 with the standard Retry-After hint when over budget', async () => {
    const budget: OrganizationRetryBudgetPort = {
      consume: jest.fn().mockResolvedValue({
        allowed: false,
        retryAfterMs: 61_250,
      }),
    };

    await expect(
      new OrganizationRetryBudgetGuard(budget).canActivate(
        contextFor(requestFor('writing.task2.grade', 'retry-2')),
      ),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 61_250,
      retryAfterHeader: true,
    });
  });

  it.each([
    ['Speaking', 'speaking.grading', 'retry-3'],
    ['missing key', 'writing.task1.grade', undefined],
  ] as const)('does not count %s', async (_label, operation, key) => {
    const consume = jest.fn().mockResolvedValue({ allowed: true });
    const budget: OrganizationRetryBudgetPort = { consume };

    await expect(
      new OrganizationRetryBudgetGuard(budget).canActivate(
        contextFor(requestFor(operation, key)),
      ),
    ).resolves.toBe(true);

    expect(consume).not.toHaveBeenCalled();
  });

  it('does not reinterpret malformed keys before the controller validates them', async () => {
    const consume = jest.fn().mockResolvedValue({ allowed: true });
    const budget: OrganizationRetryBudgetPort = { consume };

    await expect(
      new OrganizationRetryBudgetGuard(budget).canActivate(
        contextFor(requestFor('writing.task1.grade', ' '.repeat(300))),
      ),
    ).resolves.toBe(true);

    expect(consume).not.toHaveBeenCalled();
  });
});
