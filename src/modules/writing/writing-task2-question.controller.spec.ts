import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';

import { AppModule } from '../../app.module';
import { generateRequestId } from '../../common/request-context/request-id';
import { DownstreamHttpClient } from '../gateway/infrastructure/downstream-http.client';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '../idempotency/application/idempotency-repository.port';
import { IDEMPOTENCY_REPOSITORY } from '../idempotency/application/idempotency-repository.port';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

interface StoredRecord {
  fingerprintHex: string;
  requestId: string;
  state: 'pending' | 'completed' | 'failed';
  responseBody?: unknown;
}

class InMemoryIdempotencyRepository implements IdempotencyRepositoryPort {
  private readonly records = new Map<string, StoredRecord>();

  reserve(input: ReserveIdempotencyInput): Promise<IdempotencyReservation> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, {
        fingerprintHex: input.fingerprintHex,
        requestId: input.requestId,
        state: 'pending',
      });
      return Promise.resolve({ kind: 'claimed', requestId: input.requestId });
    }
    if (existing.fingerprintHex !== input.fingerprintHex) {
      return Promise.resolve({ kind: 'conflict', reason: 'fingerprint' });
    }
    if (existing.state === 'pending') {
      return Promise.resolve({ kind: 'conflict', reason: 'pending' });
    }
    if (existing.state === 'failed') {
      existing.state = 'pending';
      existing.requestId = input.requestId;
      existing.responseBody = undefined;
      return Promise.resolve({ kind: 'claimed', requestId: input.requestId });
    }
    return Promise.resolve({
      kind: 'replay',
      responseStatus: 200,
      responseBody: existing.responseBody,
    });
  }

  complete(input: CompleteIdempotencyInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      existing.state = 'completed';
      existing.responseBody = input.responseBody;
    }
    return Promise.resolve();
  }

  markFailed(input: IdempotencyAttemptInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      existing.state = 'failed';
    }
    return Promise.resolve();
  }

  delete(input: IdempotencyAttemptInput): Promise<void> {
    const key = `${input.organizationId}:${input.operation}:${input.idempotencyKey}`;
    const existing = this.records.get(key);
    if (
      existing?.state === 'pending' &&
      existing.requestId === input.requestId
    ) {
      this.records.delete(key);
    }
    return Promise.resolve();
  }

  cleanupExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

// Auth and rate limiting are the same shared guards already exercised in
// depth by writing-question.controller.spec.ts; this file focuses on what
// is actually new — routing to a different operation and its own schema.
describe('Task 2 questions HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let downstreamCalls = 0;
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
    mockAgent
      .get('https://ai-writing.test')
      .intercept({
        method: 'POST',
        path: '/question-generated-task2',
        body: JSON.stringify({ topic: 'education', question_type: 'opinion' }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, () => {
        downstreamCalls += 1;
        return fixture('question-task2.response.json');
      })
      .persist();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
      .overrideProvider(IDEMPOTENCY_REPOSITORY)
      .useValue(new InMemoryIdempotencyRepository())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
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

  it('validates, dispatches, parses, and envelopes a real fixture response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      payload: { topic: 'education', question_type: 'opinion' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        question:
          'With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?',
        topic: '',
        question_type: 'opinion',
      },
      meta: {
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
        service: 'writing',
        operation: 'writing.task2.question.generate',
        timing: {
          downstream_ms: expect.any(Number),
          gateway_overhead_ms: expect.any(Number),
          total_ms: expect.any(Number),
        },
      },
    });
  });

  it('allows Task 2 question generation without a key and does not mark a replay', async () => {
    const before = downstreamCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      payload: { topic: 'education', question_type: 'opinion' },
    });

    expect(response.statusCode).toBe(200);
    expect(downstreamCalls - before).toBe(1);
    expect(response.headers['idempotent-replay']).toBeUndefined();
  });

  it('rejects a missing topic before contacting Writing, unlike task 1 where it is optional', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      payload: { question_type: 'opinion' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('replays a keyed Task 2 question without a second downstream call', async () => {
    const headers = { 'idempotency-key': 'task2-question-replay' };
    const payload = { topic: 'education', question_type: 'opinion' };
    const before = downstreamCalls;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      headers,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      headers,
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(downstreamCalls - before).toBe(1);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().data).toEqual(first.json().data);
    expect(replay.json().meta.timing.downstream_ms).toBe(0);
  });

  it('rejects an invalid supplied optional key before contacting Writing', async () => {
    const before = downstreamCalls;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task2/questions',
      headers: { 'idempotency-key': '   ' },
      payload: { topic: 'education', question_type: 'opinion' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(downstreamCalls).toBe(before);
  });
});
