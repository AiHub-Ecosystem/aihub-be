import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { AppError } from '@/common/errors/app-error';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import type { GradedAdmissionDecision } from '@/modules/gateway/application/graded-admission.port';
import { GradedPipelineEngine } from '@/modules/gateway/application/graded-request/graded-pipeline-engine';
import type { GradedPipelineContext } from '@/modules/gateway/application/graded-request/graded-pipeline.port';
import type { GradingOrchestratorPort } from '@/modules/gateway/application/graded-request/grading-orchestrator.port';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { MeteringService } from '@/modules/metering/application/usage-recording/metering.service';
import type {
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-recording/usage-repository.port';
import { HttpExceptionFilter } from '@/modules/metering/presentation/http-exception.filter';
import { openMeteringEvidence } from '@/modules/metering/public/metering-evidence';
import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor';

class FakeQuotaCounter {
  unavailable = false;
  readonly increments: string[] = [];

  async read(): Promise<number> {
    return this.increments.length;
  }

  async increment(request: { organizationId: string }): Promise<void> {
    if (this.unavailable) throw new Error('redis unavailable');
    this.increments.push(request.organizationId);
  }
}

class FakeUsageRepository implements UsageRepositoryPort {
  readonly records: UsageRecord[] = [];

  async insert(record: UsageRecord): Promise<void> {
    this.records.push(record);
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
  allowedEnvironments: ['production'],
};

function requestFor(
  overrides: Partial<AuthenticatedApiKey> = {},
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    raw: {},
    headers: {},
  };
  const authenticated = { ...baseAuthenticated, ...overrides };
  request['aihubAuth'] = authenticated;
  request['aihubIdentity'] = {
    userId: 'user_acme',
    organizationId: authenticated.organizationId,
    scopes: [],
    mode: 'declared_id',
  };
  openMeteringEvidence(request, {
    operation: 'writing.task1.grade',
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
  });
  return request;
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

function runEngine(
  request: Record<string, unknown>,
  outcome: GradedAdmissionDecision | AppError,
  dispatchError?: AppError,
): Promise<unknown> {
  const authenticated = request['aihubAuth'] as AuthenticatedApiKey;
  const identity = request[
    'aihubIdentity'
  ] as GradedPipelineContext<'writing.task1.grade'>['identity'];
  const requestId = String(request['id']);
  const engineContext: GradedPipelineContext<'writing.task1.grade'> = {
    requestId,
    receivedAt: new Date('2026-09-16T12:00:00.000Z'),
    signal: new AbortController().signal,
    dispose: () => undefined,
    operation: 'writing.task1.grade',
    authenticated,
    identity,
    idempotencyKey: 'metering-component-key',
    metering: {
      evidence: request[
        'aihubMetering'
      ] as GradedPipelineContext<'writing.task1.grade'>['metering']['evidence'],
      setDimensions: () => undefined,
      addEvidence: (evidence) => {
        const current = request['aihubMetering'] as Record<string, unknown>;
        Object.assign(current, evidence);
      },
      markCompletionStarted: () => undefined,
      markCompletionSettled: () => undefined,
    },
    markAdmission: () => undefined,
    prepareInput: async () => ({
      input: {
        question: 'Describe the chart.',
        chart_type: 'Bar Chart',
        essay: 'A clear essay.',
        image_url: 'https://example.com/chart.png',
      },
    }),
  };
  const admission = {
    consume: async () => {
      if (outcome instanceof AppError) throw outcome;
      return outcome;
    },
  };
  const concurrency: ConcurrencyLimiterPort = {
    acquire: async () => ({
      allowed: true,
      lease: { release: async () => undefined },
    }),
  };
  const orchestrator = {
    execute: async (command: { operation: 'writing.task1.grade' }) => {
      if (dispatchError !== undefined) throw dispatchError;
      return {
        operation: command.operation,
        data: { band: 7 },
        downstreamMs: 80,
      };
    },
  } as unknown as GradingOrchestratorPort;
  const idempotency = {} as IdempotencyServicePort;
  const engine = new GradedPipelineEngine(
    orchestrator,
    { finalize: async () => undefined },
    admission,
    concurrency,
    idempotency,
    { count: async () => 0 },
  );
  return engine.execute(engineContext);
}

async function completeSuccess(
  request: Record<string, unknown>,
  result: unknown,
  metering: MeteringService,
): Promise<void> {
  await firstValueFrom(
    new SuccessEnvelopeInterceptor(metering).intercept(
      httpContextFor(request, { header: jest.fn() }) as ExecutionContext,
      { handle: () => of(result) },
    ),
  );
}

describe('quota and metering through GradedPipelineEngine', () => {
  it('hard-stop refuses an unverifiable quota and records a non-billable error', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor({ hardStopOnQuota: true });
    const failure = await runEngine(
      request,
      new AppError({
        code: 'REDIS_UNAVAILABLE',
        message: 'Grading controls are temporarily unavailable',
        retryable: true,
        retryAfterMs: 1_500,
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryAfterMs: 1_500,
    });
    const repository = new FakeUsageRepository();
    const send = jest.fn<void, [unknown]>();
    await new HttpExceptionFilter(
      new MeteringService(repository, undefined, counter),
    ).catch(
      failure,
      httpContextFor(request, {
        header: jest.fn(),
        status: () => ({ send }),
      }),
    );

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      error: { code: 'REDIS_UNAVAILABLE' },
    });
    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        outcome: 'internal_error',
        httpStatus: 503,
        billableRequests: 0,
        meteringStatus: 'not_applicable',
      }),
    );
  });

  it('preserves an admitted request and records quota uncertainty on success', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor();
    const result = await runEngine(request, {
      stage: 'admitted',
      quotaUnverified: true,
    });
    const repository = new FakeUsageRepository();
    const envelope = await firstValueFrom(
      new SuccessEnvelopeInterceptor(
        new MeteringService(repository, undefined, counter),
      ).intercept(
        httpContextFor(request, { header: jest.fn() }) as ExecutionContext,
        { handle: () => of(result) },
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

  it('preserves quota uncertainty for a non-billable dispatch error', async () => {
    const counter = new FakeQuotaCounter();
    counter.unavailable = true;
    const request = requestFor();
    const error = new AppError({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      retryable: false,
    });
    await expect(
      runEngine(
        request,
        {
          stage: 'admitted',
          quotaUnverified: true,
        },
        error,
      ),
    ).rejects.toBe(error);

    const repository = new FakeUsageRepository();
    await new HttpExceptionFilter(
      new MeteringService(repository, undefined, counter),
    ).catch(
      error,
      httpContextFor(request, {
        header: jest.fn(),
        status: () => ({ send: jest.fn() }),
      }),
    );
    expect(repository.records[0]).toEqual(
      expect.objectContaining({
        outcome: 'client_error',
        billableRequests: 0,
        meteringStatus: 'quota_unverified',
      }),
    );
  });

  it('advances the quota counter for a billable success', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor();
    const result = await runEngine(request, { stage: 'admitted' });
    const repository = new FakeUsageRepository();
    await completeSuccess(
      request,
      result,
      new MeteringService(repository, undefined, counter),
    );

    expect(counter.increments).toEqual(['org_acme']);
  });

  it('does not advance the quota counter for a non-billable error', async () => {
    const counter = new FakeQuotaCounter();
    const request = requestFor();
    const error = new AppError({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      retryable: false,
    });
    await expect(runEngine(request, { stage: 'admitted' }, error)).rejects.toBe(
      error,
    );

    const repository = new FakeUsageRepository();
    await new HttpExceptionFilter(
      new MeteringService(repository, undefined, counter),
    ).catch(
      error,
      httpContextFor(request, {
        header: jest.fn(),
        status: () => ({ send: jest.fn() }),
      }),
    );
    expect(counter.increments).toEqual([]);
  });
});
