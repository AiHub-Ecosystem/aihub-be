import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { AppError } from '@/common/errors/app-error';
import type {
  QuotaCounterPort,
  QuotaCounterRequest,
} from '@/modules/gateway/application/quota-counter.port';
import type { AuthenticatedApiKey } from '@/modules/identity/application/api-key-authenticator.port';
import { openMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import { MeteringService } from '@/modules/metering/application/metering.service';
import type {
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';
import { HttpExceptionFilter } from '@/modules/metering/presentation/http-exception.filter';
import { SuccessEnvelopeInterceptor } from '@/modules/metering/presentation/success-envelope.interceptor';
import { QuotaGuard } from './quota.guard';

class FakeQuotaCounter implements QuotaCounterPort {
  current = 0;
  unavailable = false;
  readonly reads: string[] = [];
  readonly increments: string[] = [];

  async read(request: QuotaCounterRequest): Promise<number> {
    this.reads.push(request.organizationId);
    if (this.unavailable) {
      throw new Error('redis unavailable');
    }
    return this.current;
  }

  async increment(request: QuotaCounterRequest): Promise<void> {
    if (this.unavailable) {
      throw new Error('redis unavailable');
    }
    this.increments.push(request.organizationId);
  }
}

class FakeUsageRepository implements UsageRepositoryPort {
  readonly records: UsageRecord[] = [];

  async insert(record: UsageRecord): Promise<void> {
    this.records.push(record);
  }

  aggregate(): Promise<never> {
    return Promise.reject(new Error('not used in this test'));
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

function requestFor(
  overrides: Partial<AuthenticatedApiKey> = {},
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    headers: {},
  };
  const authenticated = { ...baseAuthenticated, ...overrides };
  request.aihubAuth = authenticated;
  openMeteringEvidence(request, {
    operation: 'writing.task1.grade',
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
  });
  return request;
}

function executionContextFor(
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

function httpContextFor(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ArgumentsHost;
}

describe('quota and metering component behaviour', () => {
  const now = () => new Date('2026-09-16T12:00:00.000Z');

  it('hard-stop rejects an over-quota request and records a non-billable error', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor({ hardStopOnQuota: true });
    const quota = new QuotaGuard(counter, now);

    const failure = await quota.canActivate(executionContextFor(request)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
    });

    const repository = new FakeUsageRepository();
    const metering = new MeteringService(repository, undefined, counter);
    const send = jest.fn();
    await new HttpExceptionFilter(metering).catch(
      failure,
      httpContextFor(request, { status: () => ({ send }) }),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'QUOTA_EXCEEDED' }),
      }),
    );
    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        outcome: 'client_error',
        httpStatus: 429,
        billableRequests: 0,
        meteringStatus: 'not_applicable',
      }),
    );
  });

  it('soft-fail preserves a successful response and records quota uncertainty', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor();
    const quota = new QuotaGuard(counter, now);

    await expect(quota.canActivate(executionContextFor(request))).resolves.toBe(
      true,
    );

    const repository = new FakeUsageRepository();
    const metering = new MeteringService(repository, undefined, counter);
    const envelope = await firstValueFrom(
      new SuccessEnvelopeInterceptor(metering).intercept(
        httpContextFor(request, { header: jest.fn() }) as ExecutionContext,
        {
          handle: () =>
            of({
              operation: 'writing.task1.grade',
              data: { band: 7 },
              downstreamMs: 80,
            }),
        },
      ),
    );

    expect(envelope.data).toEqual({ band: 7 });
    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        outcome: 'success',
        billableRequests: 1,
        meteringStatus: 'quota_unverified',
      }),
    );
  });

  it('soft-fail preserves quota uncertainty for a non-billable error', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor();
    await expect(
      new QuotaGuard(counter, now).canActivate(executionContextFor(request)),
    ).resolves.toBe(true);

    const repository = new FakeUsageRepository();
    const send = jest.fn();
    await new HttpExceptionFilter(
      new MeteringService(repository, undefined, counter),
    ).catch(
      new AppError({
        code: 'INVALID_REQUEST',
        message: 'Request failed validation',
        retryable: false,
      }),
      httpContextFor(request, { status: () => ({ send }) }),
    );

    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        outcome: 'client_error',
        billableRequests: 0,
        meteringStatus: 'quota_unverified',
      }),
    );
  });

  it('advances the quota counter for a billable success on a tracked quota', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor();
    await expect(
      new QuotaGuard(counter, now).canActivate(executionContextFor(request)),
    ).resolves.toBe(true);

    const repository = new FakeUsageRepository();
    const metering = new MeteringService(repository, undefined, counter);
    await firstValueFrom(
      new SuccessEnvelopeInterceptor(metering).intercept(
        httpContextFor(request, { header: jest.fn() }) as ExecutionContext,
        {
          handle: () =>
            of({
              operation: 'writing.task1.grade',
              data: { band: 7 },
              downstreamMs: 80,
            }),
        },
      ),
    );

    expect(counter.increments).toEqual(['org_acme']);
  });

  it('does not advance the quota counter for a non-billable error', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor();
    await expect(
      new QuotaGuard(counter, now).canActivate(executionContextFor(request)),
    ).resolves.toBe(true);

    const repository = new FakeUsageRepository();
    const send = jest.fn();
    await new HttpExceptionFilter(
      new MeteringService(repository, undefined, counter),
    ).catch(
      new AppError({
        code: 'INVALID_REQUEST',
        message: 'Request failed validation',
        retryable: false,
      }),
      httpContextFor(request, { status: () => ({ send }) }),
    );

    expect(counter.increments).toEqual([]);
  });
});
