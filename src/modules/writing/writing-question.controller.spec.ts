import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';

import { AppModule } from '../../app.module';
import { AppError } from '../../common/errors/app-error';
import { generateRequestId } from '../../common/request-context/request-id';
import {
  RATE_LIMITER,
  type RateLimiterPort,
} from '../gateway/application/rate-limiter.port';
import { DownstreamHttpClient } from '../gateway/infrastructure/downstream-http.client';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type ApiKeyCredential,
  type AuthenticatedApiKey,
} from '../identity/application/api-key-authenticator.port';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');
const VALID_API_KEY = `aihub_sk_${'B'.repeat(43)}`;

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.question.generate'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('Task 1 questions HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let downstreamCalls = 0;
  let rateLimitAllowed = true;
  let authenticatedScopes = ['writing.question.generate'];
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
      .reply(200, () => {
        downstreamCalls += 1;
        return fixture('question-task1.response.json');
      })
      .persist();

    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async (credentials: ApiKeyCredential) => {
        if (credentials.value !== VALID_API_KEY) {
          throw new AppError({
            code: 'UNAUTHORIZED',
            message: 'Authentication is required',
            httpStatus: 401,
            retryable: false,
          });
        }
        return {
          ...authenticatedApiKey,
          environment: credentials.environment,
          scopes: authenticatedScopes,
        };
      },
    };
    const limiter: RateLimiterPort = {
      consume: async () =>
        rateLimitAllowed
          ? { allowed: true }
          : { allowed: false, retryAfterMs: 12_345 },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DownstreamHttpClient)
      .useValue(new DownstreamHttpClient('https://ai-writing.test', mockAgent))
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(RATE_LIMITER)
      .useValue(limiter)
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

  it('ignores malformed Idempotency-Key values for the non-idempotent operation', async () => {
    const before = downstreamCalls;
    const payload = { chart_type: 'Bar Chart' };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: { 'idempotency-key': '   ' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: { 'idempotency-key': '   ' },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(downstreamCalls - before).toBe(2);
  });

  it('validates a supplied API key and uses its organization identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: {
        host: 'api.aihub.example.com',
        'x-api-key': VALID_API_KEY,
      },
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not bypass a malformed API key even in local development', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: { 'x-api-key': 'not-a-key' },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('enforces the authenticated key rate limit before dispatch', async () => {
    rateLimitAllowed = false;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: {
        host: 'api.aihub.example.com',
        'x-api-key': VALID_API_KEY,
      },
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
        details: { retry_after_ms: 12_345 },
      },
    });

    rateLimitAllowed = true;
  });

  it('rejects an authenticated key without the required operation scope', async () => {
    authenticatedScopes = [];

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: {
        host: 'api.aihub.example.com',
        'x-api-key': VALID_API_KEY,
      },
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');

    authenticatedScopes = ['writing.question.generate'];
  });

  it('does not allow the development auth bypass in production', async () => {
    process.env.NODE_ENV = 'production';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: { host: 'api.aihub.example.com' },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    process.env.NODE_ENV = 'test';
  });

  it('does not bypass a production hostname even when the process is in development mode', async () => {
    process.env.NODE_ENV = 'development';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: { host: 'api.aihub.example.com' },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');

    process.env.NODE_ENV = 'test';
  });
});
