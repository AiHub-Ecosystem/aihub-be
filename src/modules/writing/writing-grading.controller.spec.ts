import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';

import { AppModule } from '@/app.module';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { IDEMPOTENCY_REPOSITORY } from '@/modules/idempotency/application/idempotency-repository.port';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

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
      .useValue(noOpDispatchAttemptRecord)
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

  it('rejects a non-HTTPS Task 1 image URL before downstream dispatch', async () => {
    const before = task1DownstreamCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'fixture-task1-http-image-url' },
      payload: {
        question: task1Request.question,
        chart_type: task1Request.topic,
        essay: task1Request.essay,
        image_url: 'http://charts.customer.example/chart.png',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(task1DownstreamCalls).toBe(before);
  });

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
