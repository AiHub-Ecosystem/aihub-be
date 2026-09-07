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

describe('Task 1 questions HTTP flow', () => {
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
        path: '/generate-question-task1',
        body: JSON.stringify({ topic: 'Bar Chart' }),
        headers: { authorization: 'Bearer writing-token' },
      })
      .reply(200, fixture('question-task1.response.json'));

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

    if (originalEnv.allowDev === undefined) {
      process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = undefined;
    } else {
      process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    }
    if (originalEnv.nodeEnv === undefined) {
      process.env.NODE_ENV = undefined;
    } else {
      process.env.NODE_ENV = originalEnv.nodeEnv;
    }
    if (originalEnv.token === undefined) {
      process.env.DOWNSTREAM_AI_WRITING_TOKEN = undefined;
    } else {
      process.env.DOWNSTREAM_AI_WRITING_TOKEN = originalEnv.token;
    }
    if (originalEnv.url === undefined) {
      process.env.DOWNSTREAM_AI_WRITING_URL = undefined;
    } else {
      process.env.DOWNSTREAM_AI_WRITING_URL = originalEnv.url;
    }
  });

  it('validates, dispatches, parses, and envelopes a real fixture response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: {
        'x-correlation-id': 'acme-req-123',
      },
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        question_id: '4a7c819d-46f2-42f7-a1af-ec5e7c61d31e',
        question:
          'The chart below shows the total number of minutes (in billions) of telephone calls in the UK, divided into three categories, from 1995-2002. Summarise the information by selecting a reporting the main features, and make comparisons where relevant.',
        chart_type: 'Bar Chart',
        image_url: 'https://s3.wispace.app/ielts-task1/ca95bd4ab522946d',
      },
      meta: {
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
        correlation_id: 'acme-req-123',
        service: 'writing',
        operation: 'writing.task1.question.generate',
        timing: {
          downstream_ms: expect.any(Number),
          gateway_overhead_ms: expect.any(Number),
          total_ms: expect.any(Number),
        },
      },
    });
  });

  it('rejects an unsupported chart type before contacting Writing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      payload: { chart_type: 'environment' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request failed validation',
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
      },
    });
  });

  it('does not allow the development auth bypass in production', async () => {
    process.env.NODE_ENV = 'production';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    process.env.NODE_ENV = 'test';
  });
});
