import { Blob } from 'node:buffer';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { registerBodySizeGuard } from '@/common/http/body-size.hook';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import type { DispatchObserverPort } from '@/modules/gateway/application/dispatch/dispatch-observer.port';
import { GuardedOperationDispatcher } from '@/modules/gateway/application/dispatch/guarded-operation-dispatcher';
import type { OperationTransportPort } from '@/modules/gateway/application/dispatch/operation-transport.port';
import {
  GRADED_ADMISSION,
  type GradedAdmissionDecision,
  type GradedAdmissionPort,
  type GradedAdmissionRequest,
} from '@/modules/gateway/application/graded-admission.port';
import { GradingOrchestrator } from '@/modules/gateway/application/graded-request/grading-orchestrator';
import { SandboxAdmission } from '@/modules/gateway/application/sandbox-admission';
import { RateLimitGuard } from '@/modules/gateway/presentation/rate-limit.guard';
import {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxDispatchBudgetPort,
} from '@/modules/gateway/public/sandbox-dispatch-budget';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { ApiKeyUserIdentityGuard } from '@/modules/identity/api-keys/presentation/api-key-user-identity.guard';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { MeteringFinalizerPort } from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import { HttpExceptionFilter } from '@/modules/metering/presentation/http-exception.filter';
import type { DispatchAttemptRecordPort } from '@/modules/metering/public/dispatch-attempts';
import { GetSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/get-speaking-grading-job';
import { ProcessSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/process-speaking-grading-job';
import {
  SPEAKING_GRADING_JOB_QUEUE,
  SPEAKING_GRADING_JOB_REPOSITORY,
} from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';
import { SpeakingGradingJobSweep } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.sweep';
import { SubmitSpeakingGradingJob } from '@/modules/speaking/application/grading-jobs/submit-speaking-grading-job';
import {
  SPEAKING_AUDIO_UPLOAD_REPOSITORY,
  type SpeakingAudioAssetStoragePort,
} from '@/modules/speaking/application/speaking-audio-upload.port';
import { SpeakingGradingJobsController } from './speaking-grading-jobs.controller';
import {
  ASSET_ID,
  FakeAudioRepository,
  FakeJobRepository,
  FakeQueue,
  JOB_ID,
  OWNER,
  REQUEST_BODY,
  seededJob,
  speakingAsset,
} from './speaking-grading-jobs.test-fixtures';

function json(response: { readonly payload: string }): unknown {
  return JSON.parse(response.payload);
}

describe('Speaking grading jobs HTTP flow', () => {
  let app: NestFastifyApplication;
  let repository: FakeJobRepository;
  let audioRepository: FakeAudioRepository;
  let queue: FakeQueue;
  let admissionDecision: GradedAdmissionDecision | undefined;
  let admissionCalls: GradedAdmissionRequest[];
  let pollRateLimitCalls: number;
  let idempotency: IdempotencyServicePort;
  let sandboxReservations: string[];
  let nextKey = 0;

  beforeAll(async () => {
    repository = new FakeJobRepository();
    audioRepository = new FakeAudioRepository();
    queue = new FakeQueue();
    admissionCalls = [];
    pollRateLimitCalls = 0;
    sandboxReservations = [];
    idempotency = new IdempotencyService(new InMemoryIdempotencyRepository());
    const admission: GradedAdmissionPort = {
      consume: async (request) => {
        admissionCalls.push(request);
        if (admissionDecision !== undefined) return admissionDecision;
        if (
          request.monthlyRequestQuota !== null &&
          request.monthlyRequestQuota <= 0
        ) {
          return { stage: 'quota', quota: request.monthlyRequestQuota };
        }
        return { stage: 'admitted' };
      },
    };
    const sandboxBudget: SandboxDispatchBudgetPort = {
      reserve: async (input) => {
        sandboxReservations.push(input.requestId);
        return true;
      },
      release: async () => undefined,
      allowanceFor: async () => null,
    };
    const authenticatedGuard = {
      canActivate: (context: import('@nestjs/common').ExecutionContext) => {
        const request = context
          .switchToHttp()
          .getRequest<AuthenticatedRequest>();
        const organizationHeader = request.headers['x-test-org'];
        const environmentHeader = request.headers['x-test-environment'];
        const identityHeader = request.headers['x-user-identity'];
        const organizationId =
          typeof organizationHeader === 'string'
            ? organizationHeader
            : OWNER.organizationId;
        const environment =
          environmentHeader === 'sandbox' ? 'sandbox' : 'production';
        const endUserId =
          typeof identityHeader === 'string' ? identityHeader : OWNER.endUserId;
        request.aihubAuth = {
          organizationId,
          apiKeyId: 'ak_test',
          environment,
          scopes: ['speaking.grade'],
          rateLimitRpm: 60,
          maxConcurrent: 4,
          monthlyRequestQuota: 2,
          hardStopOnQuota: true,
          allowedEnvironments: [environment],
        };
        request.aihubIdentity = {
          userId: endUserId,
          organizationId,
          scopes: [],
          mode: 'declared_id',
        };
        return true;
      },
    };
    const testingModule = Test.createTestingModule({
      controllers: [SpeakingGradingJobsController],
      providers: [
        {
          provide: SubmitSpeakingGradingJob,
          useValue: new SubmitSpeakingGradingJob(
            repository,
            queue,
            audioRepository,
            admission,
            sandboxBudget,
            idempotency,
          ),
        },
        {
          provide: GetSpeakingGradingJob,
          useValue: new GetSpeakingGradingJob(repository),
        },
        { provide: SPEAKING_GRADING_JOB_REPOSITORY, useValue: repository },
        { provide: SPEAKING_GRADING_JOB_QUEUE, useValue: queue },
        {
          provide: SPEAKING_AUDIO_UPLOAD_REPOSITORY,
          useValue: audioRepository,
        },
        { provide: GRADED_ADMISSION, useValue: admission },
        { provide: SANDBOX_DISPATCH_BUDGET, useValue: sandboxBudget },
        { provide: IDEMPOTENCY_SERVICE, useValue: idempotency },
      ],
    })
      .overrideGuard(ApiKeyUserIdentityGuard)
      .useValue(authenticatedGuard)
      .overrideGuard(RateLimitGuard)
      .useValue({
        canActivate: async () => {
          pollRateLimitCalls += 1;
          return true;
        },
      });
    const moduleRef = await testingModule.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    app.useGlobalFilters(
      new HttpExceptionFilter({
        finalize: async () => undefined,
      } satisfies MeteringFinalizerPort),
    );
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    repository.jobs.clear();
    audioRepository.assets.clear();
    audioRepository.seed(speakingAsset());
    queue.attempts.length = 0;
    queue.enqueued.length = 0;
    queue.failNext = false;
    admissionCalls.length = 0;
    admissionDecision = undefined;
    pollRateLimitCalls = 0;
    sandboxReservations.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'x-api-key': 'test-key',
      'x-user-identity': OWNER.endUserId,
      ...extra,
    };
  }

  function key(): string {
    nextKey += 1;
    return `speaking-job-${nextKey}`;
  }

  async function submit(
    body: typeof REQUEST_BODY = REQUEST_BODY,
    requestHeaders: Record<string, string> = headers(),
  ) {
    return app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/grading-jobs',
      headers: { 'content-type': 'application/json', ...requestHeaders },
      payload: body,
    });
  }

  it('accepts and queues a job without dispatching it', async () => {
    const response = await submit();
    const accepted = json(response) as {
      data: { job_id: string; status: string };
      meta: { request_id: string };
    };

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(accepted.data.job_id).toMatch(/^sgj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(accepted.data.status).toBe('queued');
    expect(accepted.meta.request_id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(repository.jobs.size).toBe(1);
    expect(queue.enqueued).toEqual([expect.any(String)]);
    expect(admissionCalls).toHaveLength(1);
    expect(pollRateLimitCalls).toBe(0);
    const job = [...repository.jobs.values()][0];
    expect(job).toMatchObject({
      maxConcurrent: 4,
      quotaTracked: true,
      identityMode: 'declared_id',
    });
  });

  it('refuses a graded admission with 429 and creates no job', async () => {
    admissionDecision = { stage: 'rate_limit', retryAfterMs: 1000 };

    const response = await submit();

    expect(response.statusCode).toBe(429);
    expect(json(response)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(repository.jobs.size).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('counts current-month in-flight jobs against the quota before creating another', async () => {
    const now = new Date();
    repository.seed({
      ...seededJob('queued'),
      jobId: `${JOB_ID.slice(0, -1)}2`,
      createdAt: now,
    });
    repository.seed({
      ...seededJob('running'),
      jobId: `${JOB_ID.slice(0, -1)}3`,
      createdAt: now,
    });

    const response = await submit();

    expect(response.statusCode).toBe(429);
    expect(json(response)).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(admissionCalls[0]?.monthlyRequestQuota).toBe(0);
    expect(repository.jobs.size).toBe(2);
    expect(queue.enqueued).toHaveLength(0);
  });

  it.each([
    ['another End-User', { 'x-user-identity': 'user_other' }],
    ['another Organization', { 'x-test-org': 'org_other' }],
    ['another Environment', { 'x-test-environment': 'sandbox' }],
  ])('hides an Audio asset owned by %s', async (_label, extraHeaders) => {
    const response = await submit(REQUEST_BODY, headers(extraHeaders));

    expect(response.statusCode).toBe(404);
    expect(json(response)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(repository.jobs.size).toBe(0);
  });

  it('hides an expired Audio asset as NOT_FOUND', async () => {
    audioRepository.assets.set(
      ASSET_ID,
      speakingAsset(OWNER, new Date(Date.now() - 1)),
    );

    const response = await submit();

    expect(response.statusCode).toBe(404);
    expect(json(response)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(repository.jobs.size).toBe(0);
  });

  it('replays the original 202 for a matching idempotency key and refuses a different body', async () => {
    const idempotencyKey = key();
    const first = await submit(
      REQUEST_BODY,
      headers({ 'idempotency-key': idempotencyKey }),
    );
    const replay = await submit(
      REQUEST_BODY,
      headers({ 'idempotency-key': idempotencyKey }),
    );
    const changed = await submit(
      { ...REQUEST_BODY, question_id: 'p1_work' },
      headers({ 'idempotency-key': idempotencyKey }),
    );

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(json(replay)).toMatchObject({
      data: (json(first) as { data: unknown }).data,
    });
    expect(changed.statusCode).toBe(409);
    expect(json(changed)).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(repository.jobs.size).toBe(1);
    expect(queue.enqueued).toHaveLength(1);
    expect(admissionCalls).toHaveLength(3);
    expect(admissionCalls.map((call) => call.monthlyRequestQuota)).toEqual([
      2,
      null,
      null,
    ]);
    expect(admissionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey,
          operation: 'speaking.v2.question-grading',
        }),
      ]),
    );
  });

  it('admission-checks a Sandbox replay without reserving another dispatch', async () => {
    const sandboxOwner = { ...OWNER, environment: 'sandbox' as const };
    const requestHeaders = headers({
      'x-test-environment': 'sandbox',
      'idempotency-key': key(),
    });
    audioRepository.seed(speakingAsset(sandboxOwner));

    const first = await submit(REQUEST_BODY, requestHeaders);
    const replay = await submit(REQUEST_BODY, requestHeaders);

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(repository.jobs.size).toBe(1);
    expect(admissionCalls).toHaveLength(2);
    expect(admissionCalls.map((call) => call.monthlyRequestQuota)).toEqual([
      null,
      null,
    ]);
    expect(sandboxReservations).toHaveLength(1);
  });

  it('answers 202 if enqueue fails after the durable job is created', async () => {
    queue.failNext = true;

    const response = await submit();

    expect(response.statusCode).toBe(202);
    expect(repository.jobs.size).toBe(1);
    expect(queue.attempts).toHaveLength(1);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('polls a succeeded job with the Speaking result and response_id', async () => {
    repository.seed(seededJob('succeeded'));

    const response = await app.inject({
      method: 'GET',
      url: `/v2/ielts/speaking/grading-jobs/${JOB_ID}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json(response)).toMatchObject({
      data: {
        job_id: JOB_ID,
        status: 'succeeded',
        result: { meta: { response_id: 'resp_123' } },
      },
    });
    expect(admissionCalls).toHaveLength(0);
    expect(pollRateLimitCalls).toBe(1);
  });

  it('polls a failed job as 200 with its safe error', async () => {
    repository.seed(seededJob('failed'));

    const response = await app.inject({
      method: 'GET',
      url: `/v2/ielts/speaking/grading-jobs/${JOB_ID}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(json(response)).toMatchObject({
      data: {
        job_id: JOB_ID,
        status: 'failed',
        error: { code: 'AUDIO_UNREADABLE', retryable: false },
      },
    });
    expect(admissionCalls).toHaveLength(0);
  });

  it('returns NOT_FOUND for a foreign or malformed job id', async () => {
    repository.seed(
      seededJob('succeeded', { ...OWNER, endUserId: 'user_other' }),
    );
    const foreign = await app.inject({
      method: 'GET',
      url: `/v2/ielts/speaking/grading-jobs/${JOB_ID}`,
      headers: headers(),
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v2/ielts/speaking/grading-jobs/not-a-job-id',
      headers: headers(),
    });

    expect(foreign.statusCode).toBe(404);
    expect(json(foreign)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(malformed.statusCode).toBe(404);
    expect(json(malformed)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('recovers submit over HTTP, dispatches through operation transport, then polls result', async () => {
    queue.failNext = true;
    const response = await submit();
    const accepted = json(response) as { data: { job_id: string } };
    const operationCalls: string[] = [];
    const result = seededJob('succeeded').result!;
    const transport = {
      prepare: async (operation: string) => ({
        send: async (call: {
          readonly onResponseReceived: (statusCode: number) => void;
        }) => {
          operationCalls.push(operation);
          call.onResponseReceived(200);
          return {
            operation,
            data: result,
            downstreamMs: 1,
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          };
        },
      }),
      isUndelivered: () => false,
    } as unknown as OperationTransportPort;
    const attempts: DispatchAttemptRecordPort = {
      beginAttempt: async () => 'attempt_1',
      recordOutcome: async () => undefined,
    };
    const observer: DispatchObserverPort = {
      deadlineMsRemaining: () => undefined,
      cancelledByDeadline: () => undefined,
    };
    const dispatcher = new GuardedOperationDispatcher(
      transport,
      attempts,
      new SandboxAdmission(undefined, () => undefined),
      observer,
      () => undefined,
    );
    const worker = new ProcessSpeakingGradingJob({
      repository,
      queue,
      audioRepository,
      audioStorage: {
        readObject: async () => ({
          blob: new Blob([Buffer.from('audio bytes')], { type: 'audio/wav' }),
          filename: 'audio.wav',
          contentType: 'audio/wav',
        }),
      } satisfies Pick<SpeakingAudioAssetStoragePort, 'readObject'>,
      concurrencyLimiter: {
        acquire: async () => ({
          allowed: true,
          lease: { release: async () => undefined },
        }),
      } satisfies ConcurrencyLimiterPort,
      orchestrator: new GradingOrchestrator(dispatcher, idempotency),
      resultOwnership: { record: async () => undefined },
      finalizer: { finalize: async () => undefined },
      sandboxBudget: { release: async () => undefined },
    });
    const sweep = new SpeakingGradingJobSweep(repository, queue, {
      release: async () => undefined,
    });

    expect(response.statusCode).toBe(202);
    expect(queue.enqueued).toHaveLength(0);
    const summary = await sweep.run(new Date(Date.now() + 61_000));
    expect(summary.staleQueuedEnqueued).toBe(1);
    expect(queue.enqueued).toEqual([accepted.data.job_id]);
    await worker.execute({
      jobId: accepted.data.job_id,
      environment: 'production',
    });

    const polled = await app.inject({
      method: 'GET',
      url: `/v2/ielts/speaking/grading-jobs/${accepted.data.job_id}`,
      headers: headers(),
    });
    expect(polled.statusCode).toBe(200);
    expect(json(polled)).toMatchObject({
      data: {
        job_id: accepted.data.job_id,
        status: 'succeeded',
        result: { meta: { response_id: result.meta.response_id } },
      },
    });
    expect(operationCalls).toEqual(['speaking.v2.question-grading']);
  });
});
