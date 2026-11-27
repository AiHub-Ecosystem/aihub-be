import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MockAgent } from 'undici/index.js';

import { AppModule } from '@/app.module';
import type { ErrorEnvelope } from '@/common/errors/error-envelope';
import { registerRequestLifecycle } from '@/common/http/hooks/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { WritingV2GradeResponseSchema } from '@/contracts/writing/v2/grading';
import { providerOrganizationId } from '@/downstream/writing/writing-v3-organization-id';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/dispatch/downstream-http.client';
import { IDEMPOTENCY_REPOSITORY } from '@/modules/idempotency/application/idempotency-repository.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { API_KEY_AUTHENTICATOR } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { USER_IDENTITY_RESOLVER } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { QUOTA_COUNTER } from '@/modules/metering/public/quota-counter';
import { fixtureJson } from '../../../../../test/support/json-fixtures';
import { useTestRuntimeConfiguration } from '../../../../../test/support/test-runtime-configuration';
import { withWritingErrorPriorityCapture } from '../../../../../test/support/writing-error-priority-fixture';

const PROVIDER_URL = 'https://ai-writing.test';
const ORGANIZATION_ID = 'org_writing_v2';
const USER_ID = 'learner_v2';

function rawFixture(name: string): unknown {
  return fixtureJson('ai-writing', name);
}

function gradeFixture(task: 1 | 2): unknown {
  return withWritingErrorPriorityCapture(
    rawFixture(`grade-v3-task${task}.response.json`) as Record<string, unknown>,
    task,
  );
}

const task1Fixture = rawFixture('grade-v3-task1.request.json') as {
  question: string;
  topic: string;
  url: string;
  essay: string;
};
const task2Fixture = rawFixture('grade-v3-task2.request.json') as {
  question: string;
  topic: string;
  essay: string;
};

const providerHeaders = {
  authorization: 'Bearer writing-token',
  'x-aihub-organization-id': providerOrganizationId(ORGANIZATION_ID),
  'x-aihub-user-id': USER_ID,
  'x-aihub-user-identity-mode': 'declared_id',
};

const GradingResponseSchema = Type.Object({
  data: WritingV2GradeResponseSchema,
  meta: Type.Object({ operation: Type.String(), request_id: Type.String() }),
});

const providerError = (error_code: string, status_code: number) => ({
  success: false,
  status_code,
  error_code,
  message: 'provider text that must never reach the customer',
  detail: 'same',
  details: null,
});

describe('Writing /v2 grading HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let downstreamCalls = 0;
  let keySequence = 0;

  const post = (path: 'task1' | 'task2', payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v2/ielts/writing/${path}/grade`,
      headers: {
        'x-api-key': 'writing-v2-key',
        'x-user-identity': USER_ID,
        'idempotency-key': `writing-v2-${(keySequence += 1)}`,
      },
      payload,
    });

  const task1Payload = {
    question: task1Fixture.question,
    chart_type: task1Fixture.topic,
    essay: task1Fixture.essay,
    image_url: task1Fixture.url,
  };
  const task2Payload = {
    question: task2Fixture.question,
    topic: task2Fixture.topic,
    essay: task2Fixture.essay,
  };

  function provider(path: string, body: Record<string, unknown>) {
    return mockAgent.get(PROVIDER_URL).intercept({
      method: 'POST',
      path,
      body: JSON.stringify(body),
      headers: providerHeaders,
    });
  }

  beforeAll(async () => {
    useTestRuntimeConfiguration({
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'true',
      DOWNSTREAM_AI_WRITING_TOKEN: 'writing-token',
      DOWNSTREAM_AI_WRITING_URL: PROVIDER_URL,
    });

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient(PROVIDER_URL, mockAgent))
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(new InMemoryIdempotencyRepository())
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue({
        beginAttempt: async () => 'test-dispatch-attempt',
        recordOutcome: async () => undefined,
      })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue({
        async authenticate({ environment }: { environment: string }) {
          return {
            organizationId: ORGANIZATION_ID,
            apiKeyId: 'ak_writing_v2',
            environment,
            scopes: ['writing.grade'],
            rateLimitRpm: 600,
            maxConcurrent: 20,
            monthlyRequestQuota: null,
            hardStopOnQuota: false,
            allowedEnvironments: [environment],
          };
        },
      })
      .overrideProvider(USER_IDENTITY_RESOLVER)
      .useValue({
        async resolve({ organizationId }: { organizationId: string }) {
          return {
            userId: USER_ID,
            organizationId,
            scopes: [],
            mode: 'declared_id',
          };
        },
      })
      .overrideProvider(QUOTA_COUNTER)
      .useValue({ read: async () => 0, increment: async () => undefined })
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => ({
          allowed: true,
          lease: { release: async () => undefined },
        }),
      })
      .overrideProvider(GRADED_ADMISSION)
      .useValue({ consume: async () => ({ stage: 'admitted' }) })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    downstreamCalls = 0;
  });

  it('grades Task 2 on provider v3 with the identity headers and the derived Organization ID, and publishes only the /v2 shape', async () => {
    provider('/v3/grading-feedback-task2', {
      question: task2Fixture.question,
      topic: task2Fixture.topic,
      essay: task2Fixture.essay,
    }).reply(200, () => {
      downstreamCalls += 1;
      return gradeFixture(2);
    });

    const response = await post('task2', task2Payload);

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls).toBe(1);
    const body = Value.Parse(GradingResponseSchema, response.json());
    expect(body.meta.operation).toBe('writing.v2.task2.grade');
    expect(body.data.criteria[0]?.id).toBe('task_response');
    expect(body.data.overall_assessment.progress.status).toEqual(
      expect.any(String),
    );
    expect(body.data.error_priority).toMatchObject([
      {
        rank: 1,
        group: 'task_achievement_response_coherence_cohesion',
        code: 'CC01',
      },
    ]);
    for (const hidden of ['coT', 'layer1_errors', '"usage"', '"metrics"']) {
      expect(response.payload).not.toContain(hidden);
    }
    // The AIHUB Organization ID never reaches the customer or the provider.
    expect(response.payload).not.toContain(
      providerOrganizationId(ORGANIZATION_ID),
    );
  });

  it('grades Task 1 on provider v3 and sends the chart type as `topic` and the image as `url`', async () => {
    provider('/v3/grading-feedback-task1', {
      question: task1Fixture.question,
      topic: task1Fixture.topic,
      essay: task1Fixture.essay,
      url: task1Fixture.url,
    }).reply(200, () => {
      downstreamCalls += 1;
      return gradeFixture(1);
    });

    const response = await post('task1', task1Payload);

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls).toBe(1);
    const body = Value.Parse(GradingResponseSchema, response.json());
    expect(body.meta.operation).toBe('writing.v2.task1.grade');
    expect(body.data.criteria[0]?.id).toBe('task_achievement');
    expect(body.data.error_priority).toMatchObject([
      {
        rank: 1,
        group: 'task_achievement_response_coherence_cohesion',
        code: 'CC01',
      },
    ]);
  });

  it('refuses an empty Task 2 essay as a non-retryable field error', async () => {
    const response = await post('task2', { ...task2Payload, essay: '' });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorEnvelope>();
    expect(error).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(error.details?.['/essay']).toEqual(expect.any(String));
    expect(downstreamCalls).toBe(0);
  });

  it.each([
    ['task1', task1Payload],
    ['task2', task2Payload],
  ] as const)(
    'refuses a %s essay of more than 1000 words before the provider is called',
    async (task, payload) => {
      const essay = Array.from({ length: 1_001 }, () => 'word').join(' ');

      const response = await post(task, { ...payload, essay });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect(downstreamCalls).toBe(0);
    },
  );

  it('refuses an unsafe Task 1 image URL before the provider is called', async () => {
    const response = await post('task1', {
      ...task1Payload,
      image_url: 'https://127.0.0.1/chart.png',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(downstreamCalls).toBe(0);
  });

  it('answers a v3 call that ends in the provider 504 (gateway_timeout after its 120 seconds) as AI_SERVICE_TIMEOUT, never forwarding the provider text', async () => {
    provider('/v3/grading-feedback-task2', {
      question: task2Fixture.question,
      topic: task2Fixture.topic,
      essay: task2Fixture.essay,
    }).reply(504, providerError('gateway_timeout', 504));

    const response = await post('task2', task2Payload);

    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({
      error: { code: 'AI_SERVICE_TIMEOUT', retryable: true },
    });
    expect(response.payload).not.toContain('provider text');
  });

  it.each([
    ['payload_too_large', 413],
    ['image_unreadable', 422],
  ])(
    'answers a provider %s as INVALID_REQUEST, not as a gateway failure',
    async (errorCode, status) => {
      provider('/v3/grading-feedback-task2', {
        question: task2Fixture.question,
        topic: task2Fixture.topic,
        essay: task2Fixture.essay,
      }).reply(status, providerError(errorCode, status));

      const response = await post('task2', task2Payload);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect(response.payload).not.toContain('provider text');
    },
  );

  it('answers a provider invalid_request, which means AIHUB sent a bad header, as AI_SERVICE_ERROR', async () => {
    provider('/v3/grading-feedback-task2', {
      question: task2Fixture.question,
      topic: task2Fixture.topic,
      essay: task2Fixture.essay,
    }).reply(400, providerError('invalid_request', 400));

    const response = await post('task2', task2Payload);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: 'AI_SERVICE_ERROR' },
    });
  });
});
