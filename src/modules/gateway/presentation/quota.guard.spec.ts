import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getRequestMeteringState } from '../../../common/request-metering/request-metering-state';
import type { AuthenticatedApiKey } from '../../identity/application/api-key-authenticator.port';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '../application/quota-counter.port';
import { QuotaGuard } from './quota.guard';

class FakeQuotaCounter implements QuotaCounterPort {
  current = 0;
  shouldFail = false;
  invalidValue = false;
  readonly reads: string[] = [];

  async read(request: { readonly organizationId: string }): Promise<number> {
    this.reads.push(request.organizationId);
    if (this.shouldFail) {
      throw new Error('redis down');
    }
    return this.invalidValue ? Number.NaN : this.current;
  }

  async increment(): Promise<void> {
    return undefined;
  }
}

const baseAuthenticated: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: 5,
  hardStopOnQuota: false,
};

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function requestFor(
  authenticated: AuthenticatedApiKey = baseAuthenticated,
): Record<string, unknown> {
  return { aihubAuth: authenticated };
}

describe('QuotaGuard', () => {
  const now = () => new Date('2026-09-16T12:00:00.000Z');

  it('skips Redis for an unlimited organization', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor({
      ...baseAuthenticated,
      monthlyRequestQuota: null,
    });
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(counter.reads).toEqual([]);
    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: false }),
    );
  });

  it('skips production quota reads and metering increments in Sandbox', async () => {
    const counter = new FakeQuotaCounter();
    counter.current = 100;
    const request = requestFor({
      ...baseAuthenticated,
      environment: 'sandbox',
      monthlyRequestQuota: 0,
    });
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(counter.reads).toEqual([]);
    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: false }),
    );
  });

  it('allows a request below the limit and marks it for quota tracking', async () => {
    const counter = new FakeQuotaCounter();
    counter.current = 4;
    const request = requestFor();
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(counter.reads).toEqual(['org_acme']);
    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: true }),
    );
  });

  it.each([5, 6])(
    'rejects a current count of %s when the quota is five',
    async (current) => {
      const counter = new FakeQuotaCounter();
      counter.current = current;
      const request = requestFor();
      const guard = new QuotaGuard(counter, now);

      await expect(
        guard.canActivate(contextFor(request)),
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        httpStatus: 429,
        retryable: true,
        retryAfterMs: 1_252_800_000,
      });
    },
  );

  // December is the one month where "the first of next month" crosses a year.
  // `Date.UTC(2026, 12, 1)` rolls over to 2027 on purpose; a hand-rolled
  // increment that clamped the month would point the caller at a date in the
  // past and hand back a retry delay of zero.
  it('points a December rejection at the first of the next year', async () => {
    const counter = new FakeQuotaCounter();
    counter.current = 5;
    const request = requestFor();
    const guard = new QuotaGuard(
      counter,
      () => new Date('2026-12-31T23:00:00.000Z'),
    );

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      retryAfterMs: 3_600_000,
    });
  });

  it('rejects a zero quota with an empty counter', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor({
      ...baseAuthenticated,
      monthlyRequestQuota: 0,
    });
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      retryAfterMs: 1_252_800_000,
    });
  });

  it('fails closed for a hard-stop organization when Redis is unavailable', async () => {
    const counter = new FakeQuotaCounter();
    counter.shouldFail = true;
    const request = requestFor({ ...baseAuthenticated, hardStopOnQuota: true });
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      retryAfterMs: 1_252_800_000,
    });

    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: true }),
    );
    expect(getRequestMeteringState(request)).not.toHaveProperty(
      'quotaUnverified',
    );
  });

  it('allows a soft-fail organization and marks quota verification as unavailable', async () => {
    const counter = new FakeQuotaCounter();
    counter.shouldFail = true;
    const request = requestFor();
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: true, quotaUnverified: true }),
    );
  });

  it('treats an invalid counter value as unavailable rather than resetting it', async () => {
    const counter = new FakeQuotaCounter();
    counter.invalidValue = true;
    const request = requestFor();
    const guard = new QuotaGuard(counter, now);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(getRequestMeteringState(request)).toEqual(
      expect.objectContaining({ quotaTracked: true, quotaUnverified: true }),
    );
  });

  it('uses the production clock when resolved by Nest', async () => {
    const counter = new FakeQuotaCounter();
    counter.shouldFail = true;
    const moduleRef = await Test.createTestingModule({
      providers: [QuotaGuard, { provide: QUOTA_COUNTER, useValue: counter }],
    }).compile();

    try {
      const guard = moduleRef.get(QuotaGuard);
      const request = requestFor({
        ...baseAuthenticated,
        hardStopOnQuota: true,
      });

      await expect(
        guard.canActivate(contextFor(request)),
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        httpStatus: 429,
        retryable: true,
      });
    } finally {
      await moduleRef.close();
    }
  });
});
