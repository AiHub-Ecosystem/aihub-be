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

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

// Auth and rate limiting are the same shared guards already exercised in
// depth by writing-question.controller.spec.ts; this file focuses on what
// is actually new — routing to a different operation and its own schema.
describe('Task 2 questions HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
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
      .reply(200, fixture('question-task2.response.json'))
      .persist();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
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
      url: '/v1/writing/task2/questions',
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

  it('rejects a missing topic before contacting Writing, unlike task 1 where it is optional', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task2/questions',
      payload: { question_type: 'opinion' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });
});
