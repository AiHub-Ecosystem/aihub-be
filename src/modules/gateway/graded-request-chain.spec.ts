import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici/index.js';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import { IDEMPOTENCY_REPOSITORY } from '@/modules/idempotency/application/idempotency-repository.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { REQUIRED_OPERATION_METADATA } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { SpeakingGradingController } from '@/modules/speaking/presentation/speaking-grading.controller';
import { SpeakingV2Controller } from '@/modules/speaking/presentation/speaking-v2.controller';
import { WritingExerciseController } from '@/modules/writing/presentation/writing-exercise.controller';
import { WritingGradingController } from '@/modules/writing/presentation/writing-grading.controller';
import { WritingV2GradingController } from '@/modules/writing/presentation/writing-v2-grading.controller';
import { DownstreamHttpClient } from './infrastructure/downstream-http.client';
import {
  GRADED_REQUEST_GUARDS,
  GRADED_REQUEST_INTERCEPTORS,
  GRADED_REQUEST_OPERATIONS,
} from './presentation/graded-request.decorator';

const FIXTURES = join(__dirname, '../../..', 'test/fixtures/ai-writing');

function operationsServedBy(controller: { prototype: object }): string[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const operations: string[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const method = prototype[name];
    if (typeof method !== 'function') {
      continue;
    }
    const operation: unknown = Reflect.getMetadata(
      REQUIRED_OPERATION_METADATA,
      method,
    );
    if (typeof operation === 'string') {
      operations.push(operation);
    }
  }
  return operations;
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

const task1Request = fixture('grade-task1.request.json') as {
  question: string;
  url: string;
  topic: string;
  essay: string;
};

const microExerciseRequest = {
  topic: 'education',
  writing_task: 2,
  criterion: 'grammatical_range_accuracy',
  error_code: 'provider-added-code',
  prompt: 'Use the target form.',
  question_type: 'grammar',
  comments: [{ quote: 'She go.', explanation: 'Use agreement.' }],
};

/**
 * The known-good order, written out literally rather than derived from the
 * declarations. This is deliberate: if the executing chain were compared against
 * the (mutable) declaration, reordering the declaration would still match
 * itself and pass, so "moving a step fails verification" would be false.
 * ADR-0018 requires quota to be read before concurrency admission; the retry
 * budget also precedes quota so its refusal takes priority over a replay; these
 * checks and concurrency admission now run inside GradedPipelineEngine.
 */
const EXPECTED_ORDER = [
  'ApiKeyGuard',
  'UserIdentityGuard',
  'GradedAdmission',
  'ConcurrencyPermit',
] as const;

describe('graded request chain', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  const executed: string[] = [];
  const originalEnv = {
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    nodeEnv: process.env.NODE_ENV,
    token: process.env.DOWNSTREAM_AI_WRITING_TOKEN,
    url: process.env.DOWNSTREAM_AI_WRITING_URL,
  };

  beforeAll(async () => {
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = 'writing-token';
    process.env.DOWNSTREAM_AI_WRITING_URL = 'https://ai-writing.test';

    // Record the real authentication guards; admission and concurrency are
    // observed at their application ports below.
    for (const guard of GRADED_REQUEST_GUARDS) {
      const original = guard.prototype.canActivate;
      jest
        .spyOn(guard.prototype, 'canActivate')
        .mockImplementation(async function (this: unknown, context) {
          executed.push(guard.name);
          return original.call(this, context);
        });
    }

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({
        method: 'POST',
        path: '/v1/grading-feedback-task1',
        body: JSON.stringify({
          question: task1Request.question,
          topic: task1Request.topic,
          essay: task1Request.essay,
          url: task1Request.url,
        }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, fixture('grade-task1.response.json'))
      .persist();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(new InMemoryIdempotencyRepository())
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue(noOpDispatchAttemptRecord)
      .overrideProvider(WEB_SESSION_CLIENT_SECRET)
      .useValue({ resolve: () => 'test-bff-client-secret' })
      .overrideProvider(GRADED_ADMISSION)
      .useValue({
        consume: async () => {
          executed.push('GradedAdmission');
          return { stage: 'admitted' };
        },
      })
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => {
          executed.push('ConcurrencyPermit');
          return {
            allowed: true,
            lease: { release: async () => undefined },
          };
        },
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = originalEnv.token;
    process.env.DOWNSTREAM_AI_WRITING_URL = originalEnv.url;
  });

  beforeEach(() => {
    executed.length = 0;
  });

  it('runs every declared step in the declared order on a real request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'chain-order-1' },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: task1Request.url,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executed).toEqual([...EXPECTED_ORDER]);
  });

  it('authenticates BFF grading requests with the shared client secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: {
        'idempotency-key': 'chain-order-bff',
        'x-aihub-client-secret': 'test-bff-client-secret',
        'x-aihub-visitor-ip': '203.0.113.10',
      },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: task1Request.url,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(executed).toEqual([...EXPECTED_ORDER]);
  });

  it('maps a provider exercise refusal to a sanitized public error', async () => {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/v2/create-micro-exercise' })
      .reply(400, fixture('micro-invalid-error-code.response.json'));

    const response = await app.inject({
      method: 'POST',
      url: '/v2/ielts/writing/micro-exercises',
      headers: { 'idempotency-key': 'exercise-provider-refusal' },
      payload: microExerciseRequest,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Writing exercise request was refused by the AI service',
        retryable: false,
      },
    });
    expect(response.body).not.toContain('Dữ liệu yêu cầu');
    expect(response.body).not.toContain('provider-added-code');
  });

  it('returns the public timeout error when exercise creation exceeds its deadline', async () => {
    const operation = OPERATION_CATALOG['writing.v2.micro-exercises.create'];
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(
      operation,
      'timeoutMs',
    );
    if (timeoutDescriptor === undefined) {
      throw new Error('exercise operation has no timeout configuration');
    }
    Object.defineProperty(operation, 'timeoutMs', {
      ...timeoutDescriptor,
      value: 1_000,
    });

    try {
      mockAgent
        .get('https://ai-writing.test')
        .intercept({ method: 'POST', path: '/v2/create-micro-exercise' })
        .reply(200, fixture('micro-annotation.response.json'))
        .delay(5_000);
      const response = await app.inject({
        method: 'POST',
        url: '/v2/ielts/writing/micro-exercises',
        headers: { 'idempotency-key': 'exercise-provider-timeout' },
        payload: microExerciseRequest,
      });

      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({
        error: { code: 'AI_SERVICE_TIMEOUT', retryable: true },
      });
    } finally {
      Object.defineProperty(operation, 'timeoutMs', timeoutDescriptor);
    }
  });

  it('declares the chain in exactly the order the real chain runs', () => {
    // Both expectations are literal, not derived from EXPECTED_ORDER: deriving
    // them would make the declaration check compare against itself, which is
    // the tautology this file exists to prevent.
    expect(GRADED_REQUEST_GUARDS.map((guard) => guard.name)).toEqual([
      'ApiKeyGuard',
      'UserIdentityGuard',
    ]);
    expect(GRADED_REQUEST_INTERCEPTORS.map((i) => i.name)).toEqual([
      'SuccessEnvelopeInterceptor',
    ]);
  });

  it('wires every graded route to the declared chain, not a private copy', () => {
    for (const controller of [
      WritingExerciseController,
      WritingGradingController,
      WritingV2GradingController,
      SpeakingGradingController,
      SpeakingV2Controller,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        ...GRADED_REQUEST_GUARDS,
      ]);
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)).toEqual([
        ...GRADED_REQUEST_INTERCEPTORS,
      ]);
    }
  });

  it('serves exactly the declared graded operations from routes that use the chain', () => {
    const served = [
      ...operationsServedBy(WritingExerciseController),
      ...operationsServedBy(WritingGradingController),
      ...operationsServedBy(WritingV2GradingController),
      ...operationsServedBy(SpeakingGradingController),
      ...operationsServedBy(SpeakingV2Controller),
    ].sort();
    // Reads the real @RequireOperation from both controllers rather than
    // restating a literal, so a graded operation added to (or dropped from) a
    // controller without updating GRADED_REQUEST_OPERATIONS fails here.
    expect(served).toEqual([...GRADED_REQUEST_OPERATIONS].sort());
  });
});
