import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import type { GradedAdmissionPort } from '@/modules/gateway/application/graded-admission.port';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { MeteringFinalizerPort } from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import { GradedPipelineEngine } from './graded-pipeline-engine';
import {
  type GradedPipelineContext,
  completeGradedPipelineResponse,
} from './graded-pipeline.port';
import type { GradingOrchestratorPort } from './grading-orchestrator.port';
import type { OutstandingQuotaReservationsPort } from './outstanding-quota-reservations';

const operation = 'writing.task1.grade' as const;
const input = {
  question: 'Describe the chart.',
  chart_type: 'Line Graph' as const,
  essay: 'A clear response.',
  image_url: 'https://example.com/chart.png',
};

function pipelineContext(
  overrides: Partial<GradedPipelineContext<typeof operation>> = {},
): GradedPipelineContext<typeof operation> {
  return {
    requestId: 'req_pipeline',
    receivedAt: new Date('2026-11-03T00:00:00.000Z'),
    signal: new AbortController().signal,
    dispose: jest.fn(),
    operation,
    authenticated: {
      organizationId: 'org_acme',
      apiKeyId: 'ak_acme',
      environment: 'production',
      scopes: ['writing.grade'],
      rateLimitRpm: 60,
      maxConcurrent: 2,
      monthlyRequestQuota: 10,
      hardStopOnQuota: true,
      allowedEnvironments: ['production'],
    },
    identity: {
      userId: 'user_acme',
      organizationId: 'org_acme',
      scopes: [],
      mode: 'declared_id',
    },
    idempotencyKey: 'key-1',
    metering: {
      evidence: {
        operation,
        organizationId: 'org_acme',
        apiKeyId: 'ak_acme',
        environment: 'production',
        settled: false,
      },
      setDimensions: jest.fn(),
      addEvidence: jest.fn(),
      markCompletionStarted: jest.fn(),
      markCompletionSettled: jest.fn(),
    },
    markAdmission: jest.fn(),
    prepareInput: jest.fn(async () => ({ input })),
    ...overrides,
  };
}

function engineWith(
  options: {
    readonly admission?: GradedAdmissionPort;
    readonly concurrency?: ConcurrencyLimiterPort;
    readonly idempotency?: IdempotencyServicePort;
    readonly orchestrator?: GradingOrchestratorPort;
    readonly reservations?: OutstandingQuotaReservationsPort;
    readonly now?: () => Date;
  } = {},
) {
  const release = jest.fn(async () => undefined);
  const engine = new GradedPipelineEngine(
    options.orchestrator ??
      ({
        execute: async (command: { operation: OperationId }) => ({
          operation: command.operation,
          data: {} as never,
          downstreamMs: 2,
        }),
      } as unknown as GradingOrchestratorPort),
    {
      finalize: jest.fn(async () => undefined),
    } as unknown as MeteringFinalizerPort,
    options.admission ?? { consume: async () => ({ stage: 'admitted' }) },
    options.concurrency ?? {
      acquire: async () => ({ allowed: true, lease: { release } }),
    },
    options.idempotency ?? ({} as IdempotencyServicePort),
    options.reservations ?? { count: async () => 0 },
    options.now ?? (() => new Date()),
  );
  return { engine, release };
}

describe('GradedPipelineEngine', () => {
  it('ignores responses without a completion callback', async () => {
    await expect(completeGradedPipelineResponse({})).resolves.toBeUndefined();
  });

  it('releases the lease after response metering completes', async () => {
    const release = jest.fn(async () => undefined);
    const { engine } = engineWith({
      concurrency: {
        acquire: async () => ({ allowed: true, lease: { release } }),
      },
    });
    const markCompletionSettled = jest.fn();
    const context = pipelineContext({
      metering: {
        ...pipelineContext().metering,
        markCompletionSettled,
      },
    });

    const result = await engine.execute(context);
    expect(release).not.toHaveBeenCalled();
    await completeGradedPipelineResponse(result);
    expect(release).toHaveBeenCalledTimes(1);
    expect(markCompletionSettled).toHaveBeenCalledTimes(1);
  });

  it('never acquires concurrency after an admission refusal', async () => {
    const acquire = jest.fn();
    const { engine } = engineWith({
      admission: {
        consume: async () => ({ stage: 'rate_limit', retryAfterMs: 1_000 }),
      },
      concurrency: { acquire },
    });

    await expect(engine.execute(pipelineContext())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('subtracts outstanding job reservations from the monthly quota before admission', async () => {
    const consume = jest.fn(async () => ({ stage: 'admitted' as const }));
    const count = jest.fn(async () => 4);
    const { engine } = engineWith({
      admission: { consume },
      reservations: { count },
    });

    await engine.execute(pipelineContext());

    expect(count).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      environment: 'production',
    });
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyRequestQuota: 6 }),
    );
  });

  it('refuses on quota when reservations exhaust it', async () => {
    const consume = jest.fn(
      async (input: { readonly monthlyRequestQuota: number | null }) =>
        input.monthlyRequestQuota === 0
          ? { stage: 'quota' as const, quota: 10 }
          : { stage: 'admitted' as const },
    );
    const { engine } = engineWith({
      admission: { consume },
      reservations: { count: async () => 10 },
    });

    await expect(engine.execute(pipelineContext())).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('admits as quota-unverified when the reservation count is unavailable', async () => {
    const consume = jest.fn(async () => ({ stage: 'admitted' as const }));
    const { engine } = engineWith({
      admission: { consume },
      reservations: {
        count: async () => {
          throw new Error('store unavailable');
        },
      },
    });
    const addEvidence = jest.fn();
    const base = pipelineContext();
    const context = {
      ...base,
      metering: { ...base.metering, addEvidence },
    };

    await engine.execute(context);

    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ monthlyRequestQuota: 10 }),
    );
    expect(addEvidence).toHaveBeenCalledWith({
      quotaUnverified: true,
    });
  });

  it('does not read reservations for a sandbox key', async () => {
    const count = jest.fn(async () => 5);
    const { engine } = engineWith({ reservations: { count } });
    const context = pipelineContext();

    await engine.execute({
      ...context,
      authenticated: { ...context.authenticated, environment: 'sandbox' },
    });

    expect(count).not.toHaveBeenCalled();
  });

  it('keeps invalid input behind an exhausted quota', async () => {
    const { engine } = engineWith({
      admission: { consume: async () => ({ stage: 'quota', quota: 10 }) },
    });
    const context = pipelineContext({
      prepareInput: jest.fn().mockRejectedValue(
        new AppError({
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          retryable: false,
        }),
      ),
    });

    await expect(engine.execute(context)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('allows only a confirmed completed Writing replay through exhausted quota', async () => {
    const replay = {
      responseStatus: 200,
      responseBody: { operation, data: { accepted: true } },
    };
    const findCompletedReplay = jest.fn(async () => replay);
    let completedReplay: unknown;
    const orchestrator = {
      execute: async (command: {
        operation: OperationId;
        completedReplay?: unknown;
      }) => {
        completedReplay = command.completedReplay;
        return { operation: command.operation, data: {}, downstreamMs: 1 };
      },
    } as unknown as GradingOrchestratorPort;
    const { engine } = engineWith({
      admission: { consume: async () => ({ stage: 'quota', quota: 10 }) },
      idempotency: { findCompletedReplay } as unknown as IdempotencyServicePort,
      orchestrator,
    });

    const result = await engine.execute(pipelineContext());

    expect(findCompletedReplay).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      operation,
      actorId: 'user_acme',
      idempotencyKey: 'key-1',
      requestBody: input,
    });
    expect(completedReplay).toEqual(replay);
    await completeGradedPipelineResponse(result);
  });

  it('releases a lease when input preparation fails after admission', async () => {
    const { engine, release } = engineWith();
    const context = pipelineContext({
      prepareInput: jest.fn().mockRejectedValue(
        new AppError({
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          retryable: false,
        }),
      ),
    });

    await expect(engine.execute(context)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(context.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses the injected clock for quota refusal timestamps', async () => {
    const fixed = new Date('2026-11-03T00:00:00.000Z');
    const { engine } = engineWith({
      admission: { consume: async () => ({ stage: 'quota', quota: 10 }) },
      now: () => fixed,
    });

    const error = await engine
      .execute(pipelineContext())
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    if (!(error instanceof AppError)) {
      throw new Error('expected AppError');
    }
    // retryAfterMs = Dec 1 00:00 UTC - Nov 3 00:00 UTC = 28 days, plus stable offset [0,10m)
    const retryAfterMs: number = error.retryAfterMs ?? Number.NaN;
    expect(retryAfterMs).toBeGreaterThanOrEqual(28 * 24 * 60 * 60 * 1000);
    expect(retryAfterMs).toBeLessThan(
      28 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
    );
  });

  it('holds the lease for detached idempotent work until background settlement', async () => {
    let background:
      | { started(): void; settled(): void | Promise<void> }
      | undefined;
    const orchestrator = {
      execute: async (command: { backgroundLifecycle?: typeof background }) => {
        background = command.backgroundLifecycle;
        background?.started();
        throw new AppError({
          code: 'AI_SERVICE_TIMEOUT',
          message: 'Timed out',
          retryable: true,
        });
      },
    } as unknown as GradingOrchestratorPort;
    const { engine, release } = engineWith({ orchestrator });

    await expect(engine.execute(pipelineContext())).rejects.toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
    });
    expect(release).not.toHaveBeenCalled();
    await background?.settled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
