import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent, FormData as UndiciFormData } from 'undici/index.js';

import { AppModule } from '@/app.module';
import { registerBodySizeGuard } from '@/common/http/body-size.hook';
import { registerRequestLifecycle } from '@/common/http/request-lifecycle.hook';
import { registerSecurityHeaders } from '@/common/http/security-headers.hook';
import { generateRequestId } from '@/common/request-context/request-id';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { registerSpeakingMultipartParser } from '@/modules/speaking/infrastructure/fastify-speaking-multipart.parser';

const FIXTURES = join(__dirname, '../../../../test/fixtures/ai-speaking');
const PROVIDER = 'https://ai-speaking.test';
const PROVIDER_AUTH = {
  'x-client-id': 'speaking-client',
  'x-secret-key': 'speaking-secret',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
  if (!isRecord(value)) {
    throw new Error(`Fixture ${name} must be a JSON object`);
  }
  return value;
}

function jsonBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : undefined;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function multipartPayload(
  fields: Readonly<Record<string, string>>,
  audio: Buffer,
): { payload: Buffer; contentType: string } {
  const boundary = '----aihub-speaking-v2-boundary';
  const parts: Buffer[] = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="answer.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf8',
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function payloadJson(response: { readonly payload: string }): unknown {
  const body: unknown = JSON.parse(response.payload);
  return body;
}

describe('Speaking v2 HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let outboundForm: UndiciFormData | undefined;
  let outboundJson: Record<string, unknown> | undefined;
  let outboundHeaders: unknown;
  const originalEnv = {
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    nodeEnv: process.env.NODE_ENV,
    speakingUrl: process.env.DOWNSTREAM_AI_SPEAKING_URL,
    speakingClientId: process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID,
    speakingSecret: process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY,
  };

  function provider(
    method: 'GET' | 'POST',
    path: string,
    statusCode: number,
    body: Record<string, unknown>,
  ): void {
    mockAgent
      .get(PROVIDER)
      .intercept({ method, path, headers: PROVIDER_AUTH })
      .reply((options) => {
        outboundHeaders = options.headers;
        if (options.body instanceof UndiciFormData) {
          outboundForm = options.body;
        } else {
          outboundJson = jsonBody(options.body);
        }
        return { statusCode, data: body };
      })
      .persist();
  }

  beforeAll(async () => {
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.DOWNSTREAM_AI_SPEAKING_URL = PROVIDER;
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = 'speaking-client';
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = 'speaking-secret';

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    provider(
      'POST',
      '/api/v2/speaking/questions/grading',
      200,
      fixture('grading-v2-question-post.200.json'),
    );
    provider(
      'POST',
      '/api/v2/speaking/parts/grading',
      200,
      fixture('grading-v2-part-post.200.json'),
    );
    provider(
      'POST',
      '/api/v2/speaking/tests/grading',
      200,
      fixture('grading-v2-test-post.200.json'),
    );
    provider(
      'GET',
      '/api/v2/speaking/responses/resp-1',
      200,
      fixture('grading-v2-question-get.200.json'),
    );
    provider(
      'GET',
      '/api/v2/speaking/parts/part-1',
      200,
      fixture('grading-v2-part-get.200.json'),
    );
    provider(
      'GET',
      '/api/v2/speaking/tests/test-1',
      200,
      fixture('grading-v2-test-get.200.json'),
    );
    provider(
      'GET',
      '/api/v2/speaking/responses/missing',
      404,
      fixture('grading-v2-not-found.404.json'),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DownstreamHttpClient)
      .useValue(
        new DownstreamHttpClient(
          { 'ai-speaking': PROVIDER, 'ai-writing': 'https://ai-writing.test' },
          mockAgent,
          { 'ai-speaking': PROVIDER_AUTH },
        ),
      )
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue(noOpDispatchAttemptRecord)
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
      new FastifyAdapter({
        bodyLimit: 1024 * 1024,
        genReqId: () => generateRequestId(),
      }),
    );
    registerSpeakingMultipartParser(app.getHttpAdapter().getInstance());
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    registerSecurityHeaders(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    outboundForm = undefined;
    outboundJson = undefined;
    outboundHeaders = undefined;
  });

  afterAll(async () => {
    await app.close();
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = originalEnv.speakingUrl;
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = originalEnv.speakingClientId;
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = originalEnv.speakingSecret;
  });

  it('grades a question: public test_type out, identity in headers, no user_id, no private fields back', async () => {
    const request = multipartPayload(
      {
        part: '1',
        question_id: 'p1_hometown',
        test_type: 'full_test',
        part_result_id: 'part-1',
      },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/questions/grade',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(payloadJson(response)).toMatchObject({
      data: {
        meta: { result_type: 'question_result', test_type: 'full_test' },
      },
      meta: { operation: 'speaking.v2.question-grading' },
    });
    expect(response.payload).toContain('"transcript":{"text":"');
    expect(response.payload).toContain(
      '"criteria":{"fluency_coherence":{"summary":',
    );
    expect(outboundForm?.get('part')).toBe('1');
    expect(outboundForm?.get('question_id')).toBe('p1_hometown');
    expect(outboundForm?.get('test_type')).toBe('Full-test');
    expect(outboundForm?.get('part_result_id')).toBe('part-1');
    expect(outboundForm?.get('user_id')).toBeNull();
    expect(headerOf(outboundHeaders, 'x-aihub-user-id')).toBe(
      'local-development',
    );
    expect(headerOf(outboundHeaders, 'x-aihub-organization-id')).toEqual(
      expect.any(String),
    );
    expect(headerOf(outboundHeaders, 'x-aihub-user-identity-mode')).toEqual(
      expect.any(String),
    );
    for (const hidden of ['user_id', 'codebook', 'pronunciation_detail']) {
      expect(response.payload).not.toContain(hidden);
    }
    expect(response.payload).not.toContain('speaking-secret');
  });

  it.each([
    ['a v1-only field', { transcript: 'text' }],
    ['the v1 test_type spelling', { test_type: 'Practice' }],
    ['a user_id field', { user_id: 'someone-else' }],
  ])('refuses a question grade with %s', async (_label, extra) => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown', ...extra },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/questions/grade',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(payloadJson(response)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(outboundForm).toBeUndefined();
  });

  it('aggregates a Part and converts test_type for the provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/parts/grade',
      headers: { 'content-type': 'application/json' },
      payload: { part_result_id: 'part-1', test_type: 'practice' },
    });

    expect(response.statusCode).toBe(200);
    expect(payloadJson(response)).toMatchObject({
      data: { meta: { result_type: 'part_result' } },
      meta: { operation: 'speaking.v2.part-grading' },
    });
    expect(outboundJson).toEqual({
      part_result_id: 'part-1',
      test_type: 'Practice',
    });
  });

  it('aggregates a Test, and refuses one that names nothing to aggregate', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/tests/grade',
      headers: { 'content-type': 'application/json' },
      payload: { test_id: 'test-1' },
    });
    expect(empty.statusCode).toBe(400);
    expect(outboundJson).toBeUndefined();

    const response = await app.inject({
      method: 'POST',
      url: '/v2/ielts/speaking/tests/grade',
      headers: { 'content-type': 'application/json' },
      payload: { test_id: 'test-1', part_result_ids: ['part-1'] },
    });
    expect(response.statusCode).toBe(200);
    expect(payloadJson(response)).toMatchObject({
      data: { meta: { result_type: 'test_result' } },
    });
    expect(outboundJson).toEqual({
      test_id: 'test-1',
      part_result_ids: ['part-1'],
    });
  });

  it.each([
    ['responses/resp-1', 'speaking.v2.response-get', 'question_result'],
    ['parts/part-1', 'speaking.v2.part-get', 'part_result'],
    ['tests/test-1', 'speaking.v2.test-get', 'test_result'],
  ])('reads %s back with a GET', async (path, operation, resultType) => {
    const response = await app.inject({
      method: 'GET',
      url: `/v2/ielts/speaking/${path}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(payloadJson(response)).toMatchObject({
      data: { meta: { result_type: resultType } },
      meta: { operation },
    });
    expect(headerOf(outboundHeaders, 'x-aihub-user-id')).toBe(
      'local-development',
    );
    expect(response.payload).not.toContain('user_id');
  });

  it('answers a result the provider does not have with NOT_FOUND', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v2/ielts/speaking/responses/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(payloadJson(response)).toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
    });
  });

  it('keeps the v1 Speaking routes registered next to v2', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    // Wrong content type for a multipart route: the route exists and refuses.
    expect(response.statusCode).not.toBe(404);
  });
});
