import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';

import { AppModule } from '@/app.module';
import { AppError } from '@/common/errors/app-error';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { IDEMPOTENCY_REPOSITORY } from '@/modules/idempotency/application/idempotency-repository.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { API_KEY_AUTHENTICATOR } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { USER_IDENTITY_RESOLVER } from '@/modules/identity/user-assertions/application/user-identity-resolver.port';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';

const FIXTURES = join(__dirname, '../../../../test/fixtures/ai-writing');

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
const task2Request = fixture('grade-task2.request.json') as {
  question: string;
  topic: string;
  essay: string;
};

// Auth and rate limiting use shared guards; this file focuses on what is
// actually new for grading: field renaming per task, the shared response
// parser wired end to end, and the coT leak guard from grade-response.adapter.
describe('Writing grading HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let task1DownstreamCalls = 0;
  let task2DownstreamCalls = 0;
  let dispatchAttemptCalls = 0;
  let quotaCount = 0;
  let retryBudgetUnavailableCalls = 0;
  let admissionUnavailable = false;
  const seenRetryKeys = new Set<string>();
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

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({
        method: 'POST',
        path: '/grading-feedback-task1',
        body: JSON.stringify({
          question: task1Request.question,
          topic: task1Request.topic,
          essay: task1Request.essay,
          url: task1Request.url,
        }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, () => {
        task1DownstreamCalls += 1;
        return fixture('grade-task1.response.json');
      })
      .persist();
    pool
      .intercept({
        method: 'POST',
        path: '/grading-feedback-task2',
        body: JSON.stringify({
          question: task2Request.question,
          topic: task2Request.topic,
          essay: task2Request.essay,
        }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, () => {
        task2DownstreamCalls += 1;
        return fixture('grade-task2.response.json');
      })
      .persist();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(new InMemoryIdempotencyRepository())
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue({
        beginAttempt: async () => {
          dispatchAttemptCalls += 1;
          return `test-dispatch-attempt-${dispatchAttemptCalls}`;
        },
        recordOutcome: async () => undefined,
      })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue({
        async authenticate({ environment }: { environment: string }) {
          return {
            organizationId: 'org_quota_replay',
            apiKeyId: 'ak_quota_replay',
            environment,
            scopes: ['writing.grade'],
            rateLimitRpm: 600,
            maxConcurrent: 20,
            monthlyRequestQuota: 1,
            hardStopOnQuota: true,
            allowedEnvironments: [environment],
          };
        },
      })
      .overrideProvider(USER_IDENTITY_RESOLVER)
      .useValue({
        async resolve({ organizationId }: { organizationId: string }) {
          return {
            userId: 'user_quota_replay',
            organizationId,
            scopes: [],
          };
        },
      })
      .overrideProvider(QUOTA_COUNTER)
      .useValue({
        async read() {
          return quotaCount;
        },
        async increment() {
          quotaCount += 1;
        },
      } satisfies QuotaCounterPort)
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => ({
          allowed: true,
          lease: { release: async () => undefined },
        }),
      })
      .overrideProvider(GRADED_ADMISSION)
      .useValue({
        async consume({
          idempotencyKey,
          monthlyRequestQuota,
        }: {
          idempotencyKey?: string;
          monthlyRequestQuota: number | null;
        }) {
          if (admissionUnavailable) {
            throw new AppError({
              code: 'REDIS_UNAVAILABLE',
              message: 'Grading controls are temporarily unavailable',
              retryable: true,
              retryAfterMs: 1_000,
            });
          }
          if (idempotencyKey === 'redis-outage-task2-key') {
            retryBudgetUnavailableCalls += 1;
            throw new AppError({
              code: 'REDIS_UNAVAILABLE',
              message: 'Grading controls are temporarily unavailable',
              retryable: true,
              retryAfterMs: 1_000,
            });
          }
          if (idempotencyKey === 'storm-task2-key') {
            if (seenRetryKeys.has(idempotencyKey)) {
              return { stage: 'retry_budget', retryAfterMs: 60_250 };
            }
            seenRetryKeys.add(idempotencyKey);
          }
          if (
            monthlyRequestQuota !== null &&
            quotaCount >= monthlyRequestQuota
          ) {
            return { stage: 'quota', quota: monthlyRequestQuota };
          }
          return { stage: 'admitted' };
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
    await app.close();

    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.DOWNSTREAM_AI_WRITING_TOKEN = originalEnv.token;
    process.env.DOWNSTREAM_AI_WRITING_URL = originalEnv.url;
  });

  it('grades Task 1 against the real fixture, using task_achievement first', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'fixture-task1-first' },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: task1Request.url,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.overall_band).toBe(7);
    expect(body.data.criteria.map((c: { id: string }) => c.id)).toEqual([
      'task_achievement',
      'coherence_cohesion',
      'lexical_resource',
      'grammatical_range_accuracy',
    ]);
    expect(body.meta.operation).toBe('writing.task1.grade');
    // The downstream chain-of-thought must never reach a public response.
    expect(response.payload).not.toContain('layer1_errors');
  });

  it('forwards a public HTTPS image URL from a customer host unchanged', async () => {
    const imageUrl = 'https://charts.customer.example/chart.png';
    mockAgent
      .get('https://ai-writing.test')
      .intercept({
        method: 'POST',
        path: '/grading-feedback-task1',
        body: JSON.stringify({
          question: task1Request.question,
          topic: task1Request.topic,
          essay: task1Request.essay,
          url: imageUrl,
        }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, () => {
        task1DownstreamCalls += 1;
        return fixture('grade-task1.response.json');
      });

    const before = task1DownstreamCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'fixture-task1-customer-host-image' },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: imageUrl,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(task1DownstreamCalls).toBe(before + 1);
  });

  it.each([
    ['http', 'http://charts.customer.example/chart.png'],
    ['file', 'file:///etc/passwd'],
    ['userinfo', 'https://user:pass@charts.customer.example/chart.png'],
    ['empty userinfo', 'https://@charts.customer.example/chart.png'],
    ['private IPv4', 'https://10.0.0.5/chart.png'],
    ['loopback IPv4', 'https://127.0.0.1/chart.png'],
    ['short IPv4 loopback form', 'https://127.1/chart.png'],
    ['link-local IPv4', 'https://169.254.169.254/latest/meta-data/'],
    ['unspecified IPv4', 'https://0.0.0.0/chart.png'],
    ['multicast IPv4', 'https://224.0.0.1/chart.png'],
    ['loopback IPv6', 'https://[::1]/chart.png'],
    ['private IPv6', 'https://[fc00::1]/chart.png'],
    ['link-local IPv6', 'https://[fe80::1]/chart.png'],
    ['multicast IPv6', 'https://[ff02::1]/chart.png'],
    ['localhost name', 'https://localhost/chart.png'],
    ['private-use .internal name', 'https://metadata.google.internal/'],
    ['single-label name', 'https://intranet/chart.png'],
    ['non-default port', 'https://charts.customer.example:8443/chart.png'],
    ['oversized URL', `https://charts.customer.example/${'a'.repeat(2_000)}`],
  ])(
    'rejects unsafe Task 1 image URL (%s) before dispatch',
    async (kind, imageUrl) => {
      const beforeDownstreamCalls = task1DownstreamCalls;
      const beforeDispatchAttempts = dispatchAttemptCalls;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ielts/writing/task1/grade',
        headers: {
          'idempotency-key': `fixture-task1-rejected-${kind.toLowerCase().replaceAll(' ', '-')}`,
        },
        payload: {
          question: task1Request.question,
          chart_type: task1Request.topic,
          essay: task1Request.essay,
          image_url: imageUrl,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(task1DownstreamCalls).toBe(beforeDownstreamCalls);
      expect(dispatchAttemptCalls).toBe(beforeDispatchAttempts);
    },
  );

  it('replays a completed Task 1 result and marks the response', async () => {
    const headers = { 'idempotency-key': 'fixture-task1-replay' };
    const payload = {
      question: task1Request.question,
      chart_type: task1Request.topic,
      essay: task1Request.essay,
      image_url: task1Request.url,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().data).toEqual(first.json().data);
    expect(replay.json().meta.timing.downstream_ms).toBe(0);
    expect(replay.json().meta.request_id).not.toBe(
      first.json().meta.request_id,
    );
  });

  it('serves a completed replay at exhausted monthly quota without another bill or dispatch', async () => {
    const headers = {
      'x-api-key': 'quota-replay-key',
      'x-user-identity': 'quota-replay-user',
      'idempotency-key': 'quota-replay-completed',
    };
    const payload = {
      question: task1Request.question,
      chart_type: task1Request.topic,
      essay: task1Request.essay,
      image_url: task1Request.url,
    };
    const beforeDispatchAttempts = dispatchAttemptCalls;
    const beforeDownstreamCalls = task1DownstreamCalls;
    quotaCount = 0;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().data).toEqual(first.json().data);
    expect(quotaCount).toBe(1);
    expect(dispatchAttemptCalls).toBe(beforeDispatchAttempts + 1);
    expect(task1DownstreamCalls).toBe(beforeDownstreamCalls + 1);
  });

  it('rejects a valid Task 1 request without Idempotency-Key before downstream dispatch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: task1Request.url,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a changed Task 1 request under a completed key', async () => {
    const headers = { 'idempotency-key': 'fixture-task1-mismatch' };
    const payload = {
      question: task1Request.question,
      chart_type: task1Request.topic,
      essay: task1Request.essay,
      image_url: task1Request.url,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload,
    });
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers,
      payload: { ...payload, essay: `${payload.essay} changed` },
    });

    expect(first.statusCode).toBe(200);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('grades Task 2 against the real fixture, using task_response first', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers: { 'idempotency-key': 'fixture-task2' },
      payload: {
        question: task2Request.question,
        topic: task2Request.topic,
        essay: task2Request.essay,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.criteria[0].id).toBe('task_response');
    expect(body.meta.operation).toBe('writing.task2.grade');
  });

  it('replays a completed Task 2 result and avoids a second downstream call', async () => {
    const headers = { 'idempotency-key': 'fixture-task2-replay' };
    const payload = {
      question: task2Request.question,
      topic: task2Request.topic,
      essay: task2Request.essay,
    };

    const before = task2DownstreamCalls;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(task2DownstreamCalls - before).toBe(1);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().data).toEqual(first.json().data);
    expect(replay.json().meta.timing.downstream_ms).toBe(0);
  });

  it('refuses an over-budget same-key retry before replay or another dispatch', async () => {
    const before = task2DownstreamCalls;
    const request = {
      method: 'POST' as const,
      url: '/v1/ielts/writing/task2/grade',
      headers: { 'idempotency-key': 'storm-task2-key' },
      payload: task2Request,
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(429);
    expect(retry.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      retry_after_ms: 60_250,
    });
    expect(retry.headers['retry-after']).toBe('61');
    expect(task2DownstreamCalls - before).toBe(1);
  });

  it('returns a retryable 503 when retry-budget Redis is unavailable on first and repeated attempts', async () => {
    const beforeBudgetCalls = retryBudgetUnavailableCalls;
    const beforeQuota = quotaCount;
    const beforeDispatchAttempts = dispatchAttemptCalls;
    const beforeDownstreamCalls = task2DownstreamCalls;
    const request = {
      method: 'POST' as const,
      url: '/v1/ielts/writing/task2/grade',
      headers: { 'idempotency-key': 'redis-outage-task2-key' },
      payload: task2Request,
    };

    const first = await app.inject(request);
    const repeat = await app.inject(request);

    for (const response of [first, repeat]) {
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'REDIS_UNAVAILABLE',
        retryable: true,
        retry_after_ms: 1_000,
      });
    }
    expect(retryBudgetUnavailableCalls).toBe(beforeBudgetCalls + 2);
    expect(quotaCount).toBe(beforeQuota);
    expect(dispatchAttemptCalls).toBe(beforeDispatchAttempts);
    expect(task2DownstreamCalls).toBe(beforeDownstreamCalls);
  });

  it('returns retryable 503 during a Redis admission outage and recovers without dispatching the failed request', async () => {
    const beforeQuota = quotaCount;
    const beforeDownstreamCalls = task1DownstreamCalls;
    const request = {
      method: 'POST' as const,
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'redis-admission-recovery-task1' },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: task1Request.url,
      },
    };

    admissionUnavailable = true;
    const unavailable = await app.inject(request);
    admissionUnavailable = false;
    const recovered = await app.inject(request);

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error).toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      retryable: true,
      retry_after_ms: 1_000,
    });
    expect(recovered.statusCode).toBe(200);
    expect(quotaCount).toBe(beforeQuota);
    expect(task1DownstreamCalls).toBe(beforeDownstreamCalls + 1);
  });

  it('rejects a Task 2 grading request without Idempotency-Key', async () => {
    const before = task2DownstreamCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      payload: {
        question: task2Request.question,
        topic: task2Request.topic,
        essay: task2Request.essay,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(task2DownstreamCalls).toBe(before);
  });

  it('rejects a Task 2 request that carries an image url, which only Task 1 accepts', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers: { 'idempotency-key': 'fixture-task2-invalid' },
      payload: {
        question: task2Request.question,
        topic: task2Request.topic,
        essay: task2Request.essay,
        image_url: 'https://example.com/chart.png',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a changed Task 2 request under a completed key', async () => {
    const headers = { 'idempotency-key': 'fixture-task2-mismatch' };
    const payload = {
      question: task2Request.question,
      topic: task2Request.topic,
      essay: task2Request.essay,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers,
      payload,
    });
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/grade',
      headers,
      payload: { ...payload, topic: 'technology' },
    });

    expect(first.statusCode).toBe(200);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects a Task 1 request missing the required image url', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
});
