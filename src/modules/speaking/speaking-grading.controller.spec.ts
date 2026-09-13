import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent, FormData as UndiciFormData } from 'undici';

import { AppModule } from '../../app.module';
import { AppError } from '../../common/errors/app-error';
import { registerBodySizeGuard } from '../../common/http/body-size.hook';
import { generateRequestId } from '../../common/request-context/request-id';
import { DownstreamHttpClient } from '../gateway/infrastructure/downstream-http.client';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from './application/speaking-multipart-parser.port';
import { registerSpeakingMultipartParser } from './infrastructure/fastify-speaking-multipart.parser';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-speaking');

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

function multipartPayload(
  fields: Readonly<Record<string, string>>,
  audio: Buffer,
  options: Readonly<{ filename?: string; contentType?: string }> = {},
): { payload: Buffer; contentType: string } {
  const boundary = '----aihub-speaking-test-boundary';
  const parts: Buffer[] = [];
  const filename = options.filename ?? 'answer.wav';
  const contentType = options.contentType ?? 'audio/wav';

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
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

function speakingTimeout(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    retryable: true,
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(speakingTimeout());
      return;
    }
    signal.addEventListener('abort', () => reject(speakingTimeout()), {
      once: true,
    });
  });
}

describe('Speaking grading HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let providerResponse: { statusCode: number; body: Record<string, unknown> };
  let outboundBody: UndiciFormData | undefined;
  const originalEnv = {
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    nodeEnv: process.env.NODE_ENV,
    speakingUrl: process.env.DOWNSTREAM_AI_SPEAKING_URL,
    speakingClientId: process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID,
    speakingSecret: process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY,
  };

  beforeAll(async () => {
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.DOWNSTREAM_AI_SPEAKING_URL = 'https://ai-speaking.test';
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = 'speaking-client';
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = 'speaking-secret';
    providerResponse = {
      statusCode: 200,
      body: fixture('grading.response.json'),
    };

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent
      .get('https://ai-speaking.test')
      .intercept({
        method: 'POST',
        path: '/api/v1/speaking/grading',
        headers: {
          'x-client-id': 'speaking-client',
          'x-secret-key': 'speaking-secret',
        },
      })
      .reply((options) => {
        if (options.body instanceof UndiciFormData) {
          outboundBody = options.body;
        }
        return {
          statusCode: providerResponse.statusCode,
          data: providerResponse.body,
        };
      })
      .persist();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DownstreamHttpClient)
      .useValue(
        new DownstreamHttpClient(
          {
            'ai-speaking': 'https://ai-speaking.test',
            'ai-writing': 'https://ai-writing.test',
          },
          mockAgent,
          {
            'ai-speaking': {
              'x-client-id': 'speaking-client',
              'x-secret-key': 'speaking-secret',
            },
          },
        ),
      )
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        bodyLimit: 1024 * 1024,
        genReqId: () => generateRequestId(),
      }),
    );
    registerSpeakingMultipartParser(app.getHttpAdapter().getInstance());
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();

    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = originalEnv.speakingUrl;
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = originalEnv.speakingClientId;
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = originalEnv.speakingSecret;
  });

  it('forwards a valid multipart request and normalizes the scoring response', async () => {
    const request = multipartPayload(
      {
        part: '1',
        question_id: 'p1_hometown',
        prompt_text: 'Do you enjoy living in your hometown?',
        test_type: 'Practice',
      },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.operation).toBe('speaking.grading');
    expect(body.data.scorability.is_scorable).toBe(false);
    expect(body.data.estimated_band.overall).toEqual(expect.any(Number));
    expect(body.data.transcript.word_count).toBeGreaterThanOrEqual(0);
    expect(body.data.fluency_metrics.speech_rate_wpm).toBeNull();
    expect(body.data.performance_timing).toHaveProperty('deepseek_seconds');
    expect(body.data).not.toHaveProperty('session_id');
    expect(body.data).not.toHaveProperty('test_id');
    expect(body.data).not.toHaveProperty('user_id');
    expect(outboundBody?.get('user_id')).toBe('local-development');
    expect(outboundBody?.get('part')).toBe('1');
    expect(outboundBody?.get('question_id')).toBe('p1_hometown');
    expect(outboundBody?.get('prompt_text')).toBe(
      'Do you enjoy living in your hometown?',
    );
    expect(response.payload).not.toContain('speaking-secret');
  });

  it('rejects a request that tries to override the verified downstream user', async () => {
    const request = multipartPayload(
      {
        user_id: 'attacker-user',
        part: '1',
        question_id: 'p1_hometown',
      },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects missing required grading metadata before downstream dispatch', async () => {
    const request = multipartPayload(
      { question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects unsupported audio formats at the public boundary', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
      { filename: 'answer.txt', contentType: 'text/plain' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a declared body beyond the 25 MB operation limit', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: {
        'content-type': request.contentType,
        'content-length': String(25 * 1024 * 1024 + 1),
      },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an uploaded audio file beyond the 25 MB multipart limit', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(25 * 1024 * 1024 + 1, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts multipart audio above the global JSON body ceiling', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(2 * 1024 * 1024, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
  });

  it('maps an upload deadline cancellation through the public error envelope', async () => {
    const parser = app.get<SpeakingMultipartParserPort>(
      SPEAKING_MULTIPART_PARSER,
    );
    const originalParse = parser.parse;
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    parser.parse = async (_request, signal) => waitForAbort(signal);

    try {
      const request = multipartPayload(
        { part: '1', question_id: 'p1_hometown' },
        Buffer.alloc(200, 1),
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/speaking/grading',
        headers: { 'content-type': request.contentType },
        payload: request.payload,
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('AI_SERVICE_TIMEOUT');
    } finally {
      parser.parse = originalParse;
      timeout.mockRestore();
    }
  });

  it('aborts upload work when the client disconnects', async () => {
    const parser = app.get<SpeakingMultipartParserPort>(
      SPEAKING_MULTIPART_PARSER,
    );
    const originalParse = parser.parse;
    parser.parse = async (source, signal) => {
      const pending = waitForAbort(signal);
      queueMicrotask(() => source.abort());
      return pending;
    };

    try {
      const request = multipartPayload(
        { part: '1', question_id: 'p1_hometown' },
        Buffer.alloc(200, 1),
      );
      await expect(
        app.inject({
          method: 'POST',
          url: '/v1/speaking/grading',
          headers: { 'content-type': request.contentType },
          payload: request.payload,
        }),
      ).rejects.toThrow('response destroyed before completion');
    } finally {
      parser.parse = originalParse;
    }
  });

  it('maps provider authentication failures without exposing provider detail', async () => {
    providerResponse = {
      statusCode: 401,
      body: { detail: 'private provider credential detail' },
    };

    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('AI_SERVICE_ERROR');
    expect(response.json().error.retryable).toBe(false);
    expect(response.payload).not.toContain(
      'private provider credential detail',
    );

    providerResponse = {
      statusCode: 200,
      body: fixture('grading.response.json'),
    };
  });

  it.each([400, 413, 500])(
    'maps provider HTTP %i to the shared service error',
    async (statusCode) => {
      providerResponse = {
        statusCode,
        body: { detail: 'private provider failure detail' },
      };

      const request = multipartPayload(
        { part: '1', question_id: 'p1_hometown' },
        Buffer.alloc(200, 1),
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/speaking/grading',
        headers: { 'content-type': request.contentType },
        payload: request.payload,
      });

      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('AI_SERVICE_ERROR');
      expect(response.json().error.retryable).toBe(statusCode >= 500);
      expect(response.payload).not.toContain('private provider failure detail');

      providerResponse = {
        statusCode: 200,
        body: fixture('grading.response.json'),
      };
    },
  );

  it('maps a malformed provider success body to a contract violation', async () => {
    providerResponse = {
      statusCode: 200,
      body: { status: 'success', data: { session_id: 'session-only' } },
    };

    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');

    providerResponse = {
      statusCode: 200,
      body: fixture('grading.response.json'),
    };
  });
});
