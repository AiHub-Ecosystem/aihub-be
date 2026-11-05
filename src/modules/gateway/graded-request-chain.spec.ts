import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fastifyCookie from '@fastify/cookie';
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
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { PASSWORD_HASHER } from '@/modules/auth/local-credentials/application/password-hasher.port';
import { AUTH_MFA_SERVICE } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { AUTH_RATE_LIMITER } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import {
  type InMemoryAuthState,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryRefreshSessionAdapter } from '@/modules/auth/testing/in-memory-refresh-session.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import {
  AccessTokenIssuerFake,
  HasherFake,
  LimiterFake,
  MfaFake,
  RefreshTokenIssuerFake,
} from '@/modules/auth/testing/local-auth.controller.spec-support';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';
import { REFRESH_TOKEN_ISSUER } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { USER_ACCESS_TOKEN_ISSUER } from '@/modules/auth/web-sessions/application/user-access-token.port';
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
import {
  WritingExerciseController,
  WritingGradingController,
  WritingV2GradingController,
} from '@/modules/writing/public/grading';
import { DownstreamHttpClient } from './infrastructure/dispatch/downstream-http.client';
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
  let authState: InMemoryAuthState;
  const executed: string[] = [];
  const originalEnv = {
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    nodeEnv: process.env.NODE_ENV,
    token: process.env.DOWNSTREAM_AI_WRITING_TOKEN,
    url: process.env.DOWNSTREAM_AI_WRITING_URL,
    speakingToken: process.env.DOWNSTREAM_AI_SPEAKING_TOKEN,
    speakingUrl: process.env.DOWNSTREAM_AI_SPEAKING_URL,
  };

  beforeAll(async () => {
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = 'writing-token';
    process.env.DOWNSTREAM_AI_WRITING_URL = 'https://ai-writing.test';
    process.env.DOWNSTREAM_AI_SPEAKING_TOKEN = 'speaking-token';
    process.env.DOWNSTREAM_AI_SPEAKING_URL = 'https://ai-speaking.test';

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
    mockAgent
      .get('https://ai-speaking.test')
      .intercept({ method: 'POST', path: '/simulate-provider-hang' })
      .reply(200, {})
      .delay(30_000)
      .persist();

    authState = createInMemoryAuthState();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(authState))
      .overrideProvider(PASSWORD_HASHER)
      .useValue(new HasherFake())
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(new LimiterFake())
      .overrideProvider(REFRESH_SESSION_REPOSITORY)
      .useValue(new InMemoryRefreshSessionAdapter(authState))
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(new AccessTokenIssuerFake())
      .overrideProvider(REFRESH_TOKEN_ISSUER)
      .useValue(new RefreshTokenIssuerFake())
      .overrideProvider(AUTH_MFA_SERVICE)
      .useValue(new MfaFake())
      .overrideProvider(DownstreamHttpClient)
      .useValue(
        new DownstreamHttpClient(
          {
            'ai-writing': 'https://ai-writing.test',
            'ai-speaking': 'https://ai-speaking.test',
          },
          mockAgent,
        ),
      )
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
    const fastify = app.getHttpAdapter().getInstance();
    await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
    registerRequestLifecycle(fastify);
    await app.init();
    await fastify.ready();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = originalEnv.token;
    process.env.DOWNSTREAM_AI_WRITING_URL = originalEnv.url;
    process.env.DOWNSTREAM_AI_SPEAKING_TOKEN = originalEnv.speakingToken;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = originalEnv.speakingUrl;
  });

  beforeEach(() => {
    executed.length = 0;
    authState.reset();
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

  it('keeps Core Auth and Writing grading responsive while AI Speaking hangs', async () => {
    const client = app.get(DownstreamHttpClient);
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const stalled = controllers.map((controller, index) =>
      client.request(
        { method: 'POST', path: '/simulate-provider-hang', body: {} },
        {
          downstream: 'ai-speaking',
          requestId: `req_slow_speaking_${index}`,
          deadlineMs: 30_000,
          signal: controller.signal,
        },
      ),
    );
    let speakingSettled = false;
    const settled = Promise.allSettled(stalled).then(
      () => (speakingSettled = true),
    );

    try {
      seedAccount(authState, {
        userId: 'usr_01J00000000000000000000000',
        email: 'student@example.test',
        username: 'student',
        passwordHash: 'stored-password-hash',
      });
      const auth = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: 'student@example.test',
          password: 'correct-password',
        },
      });
      expect(auth.statusCode).toBe(200);
      expect(auth.headers['set-cookie']).toBeDefined();
      expect(speakingSettled).toBe(false);

      const writing = await app.inject({
        method: 'POST',
        url: '/v1/ielts/writing/task1/grade',
        headers: { 'idempotency-key': 'slow-speaking-isolation' },
        payload: {
          question: task1Request.question,
          chart_type: task1Request.topic,
          essay: task1Request.essay,
          image_url: task1Request.url,
        },
      });
      expect(writing.statusCode).toBe(200);
      expect(speakingSettled).toBe(false);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await settled;
    }
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
