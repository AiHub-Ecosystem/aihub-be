import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MockAgent, FormData as UndiciFormData } from 'undici';

import { AppModule } from '../../app.module';
import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { AppError } from '../../common/errors/app-error';
import { registerBodySizeGuard } from '../../common/http/body-size.hook';
import { registerRequestLifecycle } from '../../common/http/request-lifecycle.hook';
import { generateRequestId } from '../../common/request-context/request-id';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
} from '../gateway/application/grading-orchestrator.port';
import { DownstreamHttpClient } from '../gateway/infrastructure/downstream-http.client';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from './application/speaking-multipart-parser.port';
import {
  SPEAKING_AUDIO_MAX_BYTES,
  registerSpeakingMultipartParser,
} from './infrastructure/fastify-speaking-multipart.parser';

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

function jsonBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  }
  if (value instanceof Uint8Array) {
    const parsed: unknown = JSON.parse(Buffer.from(value).toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  }
  return undefined;
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
  let outboundJson: Record<string, unknown> | undefined;
  let abortJsonRequest = false;
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
    mockAgent
      .get('https://ai-speaking.test')
      .intercept({
        method: 'POST',
        path: '/api/v1/speaking/grading-json',
        headers: {
          'x-client-id': 'speaking-client',
          'x-secret-key': 'speaking-secret',
        },
      })
      .reply((options) => {
        outboundJson = jsonBody(options.body);
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
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('preHandler', (request, _reply, done) => {
        if (
          abortJsonRequest &&
          request.url === '/v1/ielts/speaking/grading-json'
        ) {
          request.raw.emit('aborted');
        }
        done();
      });
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
      url: '/v1/ielts/speaking/grading',
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
    expect(body.data.pronunciation_detail.words[0].syllables).toEqual(
      expect.any(Array),
    );
    expect(body.data.pronunciation_detail.words[0].phonemes).toEqual(
      expect.any(Array),
    );
    expect(body.data.language_analysis.grammar_errors).toEqual(
      expect.any(Array),
    );
    expect(body.data.language_analysis.vocabulary_upgrades).toEqual(
      expect.any(Array),
    );
    expect(body.data).not.toHaveProperty('performance_timing');
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

  it('applies the Practice default when test_type is omitted', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(outboundBody?.get('test_type')).toBe('Practice');
    expect(outboundBody?.get('prompt_text')).toBeNull();
    expect(outboundBody?.get('test_code')).toBeNull();
    expect(outboundBody?.get('transcript')).toBeNull();
  });

  it('forwards a valid JSON audio URL and normalizes the scoring response', async () => {
    outboundJson = undefined;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload: {
        audio_url:
          'https://s3.wispace.app/audio/sample.mp3?signature=contract-test',
        part: 1,
        question_id: 'p1_hometown',
        prompt_text: 'Do you enjoy living in your hometown?',
        test_type: 'Practice',
        test_code: 'TEST-001',
        transcript: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta.operation).toBe('speaking.grading-json');
    expect(response.json().data).not.toHaveProperty('performance_timing');
    expect(response.json().data).not.toHaveProperty('user_id');
    expect(outboundJson).toEqual({
      user_id: 'local-development',
      part: 1,
      question_id: 'p1_hometown',
      audio_url:
        'https://s3.wispace.app/audio/sample.mp3?signature=contract-test',
      test_type: 'Practice',
      prompt_text: 'Do you enjoy living in your hometown?',
      test_code: 'TEST-001',
      transcript: null,
    });
  });

  it('passes decoded Speaking inputs and the upload signal to the orchestrator', async () => {
    const parser = app.get<SpeakingMultipartParserPort>(
      SPEAKING_MULTIPART_PARSER,
    );
    const orchestrator = app.get<GradingOrchestratorPort>(GRADING_ORCHESTRATOR);
    const parse = jest.spyOn(parser, 'parse');
    const execute = jest.spyOn(orchestrator, 'execute');

    try {
      const multipart = multipartPayload(
        { part: '1', question_id: 'p1_hometown' },
        Buffer.alloc(200, 1),
      );
      const upload = await app.inject({
        method: 'POST',
        url: '/v1/ielts/speaking/grading',
        headers: { 'content-type': multipart.contentType },
        payload: multipart.payload,
      });
      expect(upload.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'speaking.grading',
          input: expect.objectContaining({
            part: 1,
            questionId: 'p1_hometown',
          }),
          signal: parse.mock.calls[0]?.[1],
          receivedAt: expect.any(Date),
          userId: 'local-development',
        }),
      );

      execute.mockClear();
      const json = await app.inject({
        method: 'POST',
        url: '/v1/ielts/speaking/grading-json',
        headers: { 'content-type': 'application/json' },
        payload: {
          audio_url: 'https://s3.wispace.app/audio/sample.mp3',
          part: 1,
          question_id: 'p1_hometown',
        },
      });
      expect(json.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'speaking.grading-json',
          input: expect.objectContaining({
            audioUrl: 'https://s3.wispace.app/audio/sample.mp3',
            testType: 'Practice',
          }),
          receivedAt: expect.any(Date),
          signal: expect.any(AbortSignal),
          userId: 'local-development',
        }),
      );
    } finally {
      parse.mockRestore();
      execute.mockRestore();
    }
  });

  it('maps a JSON upload deadline that expires while parsing to 504', async () => {
    outboundJson = undefined;
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ielts/speaking/grading-json',
        headers: { 'content-type': 'application/json' },
        payload: Readable.from([
          JSON.stringify({
            audio_url: 'https://s3.wispace.app/audio/sample.mp3',
            part: 1,
            question_id: 'p1_hometown',
          }),
        ]),
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('AI_SERVICE_TIMEOUT');
      expect(outboundJson).toBeUndefined();
    } finally {
      timeout.mockRestore();
    }
  });

  it('does not expose the old unnamespaced JSON route alias', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload: {
        audio_url: 'https://s3.wispace.app/audio/sample.mp3',
        part: 1,
        question_id: 'p1_hometown',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('applies JSON defaults and does not accept a client user_id', async () => {
    outboundJson = undefined;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload: {
        audio_url: 'https://s3.wispace.app/audio/sample.mp3',
        part: 1,
        question_id: 'p1_hometown',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(outboundJson).toMatchObject({
      user_id: 'local-development',
      test_type: 'Practice',
      prompt_text: null,
      test_code: null,
      transcript: null,
    });

    const override = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload: {
        audio_url: 'https://s3.wispace.app/audio/sample.mp3',
        part: 1,
        question_id: 'p1_hometown',
        user_id: 'attacker-user',
      },
    });

    expect(override.statusCode).toBe(400);
    expect(override.json().error.code).toBe('INVALID_REQUEST');
  });

  it.each([
    {},
    { audio_url: 'https://s3.wispace.app/audio/sample.mp3', part: 1 },
    {
      audio_url: 'http://s3.wispace.app/audio/sample.mp3',
      part: 1,
      question_id: 'p1_hometown',
    },
    {
      audio_url: 'https://evil.example/audio/sample.mp3',
      part: 1,
      question_id: 'p1_hometown',
    },
    {
      audio_url: 'https://s3.wispace.app:8443/audio/sample.mp3',
      part: 1,
      question_id: 'p1_hometown',
    },
  ])('rejects invalid JSON audio request %#', async (payload) => {
    outboundJson = undefined;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(outboundJson).toBeUndefined();
  });

  it('maps a malformed JSON provider success body to a contract violation', async () => {
    providerResponse = {
      statusCode: 200,
      body: { status: 'success', data: { session_id: 'session-only' } },
    };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading-json',
      headers: { 'content-type': 'application/json' },
      payload: {
        audio_url: 'https://s3.wispace.app/audio/sample.mp3',
        part: 1,
        question_id: 'p1_hometown',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');

    providerResponse = {
      statusCode: 200,
      body: fixture('grading.response.json'),
    };
  });

  it.each([
    [400, 502, 'AI_SERVICE_ERROR', false],
    [429, 503, 'AI_SERVICE_THROTTLED', true],
    [500, 502, 'AI_SERVICE_ERROR', true],
  ] as const)(
    'maps JSON provider HTTP %i to the public error contract',
    async (providerStatus, publicStatus, errorCode, retryable) => {
      providerResponse = {
        statusCode: providerStatus,
        body: { detail: 'private JSON provider failure detail' },
      };

      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/ielts/speaking/grading-json',
          headers: { 'content-type': 'application/json' },
          payload: {
            audio_url: 'https://s3.wispace.app/audio/sample.mp3',
            part: 1,
            question_id: 'p1_hometown',
          },
        });

        expect(response.statusCode).toBe(publicStatus);
        expect(response.json().error.code).toBe(errorCode);
        expect(response.json().error.retryable).toBe(retryable);
        expect(response.payload).not.toContain(
          'private JSON provider failure detail',
        );
      } finally {
        providerResponse = {
          statusCode: 200,
          body: fixture('grading.response.json'),
        };
      }
    },
  );

  it('maps a JSON downstream timeout to the public timeout contract', async () => {
    const client = app.get(DownstreamHttpClient);
    const request = {
      audio_url: 'https://s3.wispace.app/audio/sample.mp3',
      part: 1,
      question_id: 'p1_hometown',
    };
    const timeout = jest
      .spyOn(client, 'request')
      .mockRejectedValueOnce(speakingTimeout());

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ielts/speaking/grading-json',
        headers: { 'content-type': 'application/json' },
        payload: request,
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('AI_SERVICE_TIMEOUT');
    } finally {
      timeout.mockRestore();
    }
  });

  it('maps a JSON client disconnect to the public timeout contract', async () => {
    abortJsonRequest = true;

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ielts/speaking/grading-json',
        headers: { 'content-type': 'application/json' },
        payload: {
          audio_url: 'https://s3.wispace.app/audio/sample.mp3',
          part: 1,
          question_id: 'p1_hometown',
        },
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('AI_SERVICE_TIMEOUT');
    } finally {
      abortJsonRequest = false;
    }
  });

  it('preserves a null fluency_metrics group from the provider', async () => {
    const providerBody = fixture('grading.response.json');
    if (!isRecord(providerBody.data)) {
      throw new Error('Fixture data must be an object');
    }
    providerResponse = {
      statusCode: 200,
      body: {
        ...providerBody,
        data: { ...providerBody.data, fluency_metrics: null },
      },
    };

    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.fluency_metrics).toBeNull();

    providerResponse = {
      statusCode: 200,
      body: fixture('grading.response.json'),
    };
  });

  it('rejects an unsupported test_type at the public boundary', async () => {
    const request = multipartPayload(
      {
        part: '1',
        question_id: 'p1_hometown',
        test_type: 'Exam',
      },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
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
      url: '/v1/ielts/speaking/grading',
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
      url: '/v1/ielts/speaking/grading',
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
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a declared body beyond the 26 MB operation limit', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(200, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: {
        'content-type': request.contentType,
        'content-length': String(
          OPERATION_CATALOG['speaking.grading'].maxBodyBytes + 1,
        ),
      },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an uploaded audio file beyond the 25 MB audio limit', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(SPEAKING_AUDIO_MAX_BYTES + 1, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a full-size 25 MB audio file within the 26 MB wire ceiling', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(SPEAKING_AUDIO_MAX_BYTES, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
      headers: { 'content-type': request.contentType },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(200);
  });

  it('accepts multipart audio above the global JSON body ceiling', async () => {
    const request = multipartPayload(
      { part: '1', question_id: 'p1_hometown' },
      Buffer.alloc(2 * 1024 * 1024, 1),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/speaking/grading',
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
        url: '/v1/ielts/speaking/grading',
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
          url: '/v1/ielts/speaking/grading',
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
      url: '/v1/ielts/speaking/grading',
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
        url: '/v1/ielts/speaking/grading',
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
      url: '/v1/ielts/speaking/grading',
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
