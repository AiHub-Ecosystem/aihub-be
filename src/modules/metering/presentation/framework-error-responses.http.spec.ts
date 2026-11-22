import { type AddressInfo, connect, createServer } from 'node:net';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ConnectionError } from 'fastify';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import {
  clientErrorResponse,
  createAppFastifyErrorOptions,
} from '@/common/http/framework-error-responses';
import { isRecord } from '@/common/is-record';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import { appConfig } from '@/config/runtime-configuration';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { writeRequestCompletion } from '@/modules/metering/public/http-hooks';
import { QUOTA_COUNTER } from '@/modules/metering/public/quota-counter';
import { RUNTIME_CONNECTION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';
import { registerRequestHooks } from '@/register-request-hooks';

// Booting AppModule exceeds Jest's five-second default on a busy machine.
jest.setTimeout(60_000);

const GRADE_OPERATION = OPERATION_CATALOG['writing.task1.grade'];
const GRADE_URL = GRADE_OPERATION.path;
const API_KEY_VALUE = 'framework-error-test-key';
const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

const testApiKeyAuthenticator: ApiKeyAuthenticatorPort = {
  authenticate: ({ environment, value }) => {
    if (value !== API_KEY_VALUE) {
      return Promise.reject(
        new AppError({
          code: 'UNAUTHORIZED',
          message: 'API key is invalid',
          retryable: false,
        }),
      );
    }
    return Promise.resolve({
      organizationId: 'org_local-development',
      apiKeyId: 'ak_framework_error_test',
      environment,
      scopes: [GRADE_OPERATION.requiredScope],
      rateLimitRpm: 60,
      maxConcurrent: 1,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
      allowedEnvironments: ['production'],
    });
  },
};

class CapturedLog {
  private readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  reset(): void {
    this.lines.length = 0;
  }

  completions(): Record<string, unknown>[] {
    return this.lines.flatMap((line) => {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) && parsed['event'] === 'request_completed'
        ? [parsed]
        : [];
    });
  }
}

function expectEnvelope(
  response: { statusCode: number; json(): unknown },
  status: number,
  code: string,
): { readonly requestId: string; readonly message: string } {
  expect(response.statusCode).toBe(status);
  const body = response.json();
  expect(isRecord(body) && isRecord(body['error'])).toBe(true);
  const error = (body as { error: Record<string, unknown> }).error;
  expect(error['code']).toBe(code);
  expect(error['retryable']).toBe(false);
  expect(error['request_id']).toMatch(REQUEST_ID_PATTERN);
  expect(typeof error['message']).toBe('string');
  return {
    requestId: String(error['request_id']),
    message: String(error['message']),
  };
}

interface RawResponse {
  readonly status: number;
  readonly head: string;
  readonly body: string;
}

async function rawRequest(port: number, bytes: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(bytes);
    });
    let received = '';
    let settled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
      const separator = received.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const head = received.slice(0, separator);
      const body = received.slice(separator + 4);
      const contentLength = Number(
        /content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0,
      );
      if (Buffer.byteLength(body) < contentLength) return;
      settled = true;
      socket.destroy();
      resolve({ status: Number(head.split(' ')[1]), head, body });
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!settled) reject(new Error('socket closed without a response'));
    });
  });
}

/**
 * Node does not emit a `clientError` for `server.requestTimeout` under Jest's
 * test environment, so the timeout branch is driven directly against a real
 * socket rather than waiting on a timer that may never fire.
 */
function captureClientError(code: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const socket = connect({ host: '127.0.0.1', port }, () => {
        clientErrorResponse({ code } as ConnectionError, socket);
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        server.close(() => resolve(chunks.join('')));
      });
    });
  });
}

function parseRawResponse(raw: string): RawResponse {
  const separator = raw.indexOf('\r\n\r\n');
  const head = separator < 0 ? raw : raw.slice(0, separator);
  return {
    status: Number(head.split(' ')[1]),
    head,
    body: separator < 0 ? '' : raw.slice(separator + 4),
  };
}

function expectRawEnvelope(response: RawResponse, status: number): void {
  expect(response.status).toBe(status);
  expect(response.head).toContain('Content-Type: application/json');
  expect(response.head).toMatch(/X-Request-Id: req_[0-9A-HJKMNP-TV-Z]{26}/);

  const parsed: unknown = JSON.parse(response.body);
  expect(isRecord(parsed) && isRecord(parsed['error'])).toBe(true);
  const error = (parsed as { error: Record<string, unknown> }).error;
  expect(error['code']).toBe('INVALID_REQUEST');
  expect(error['retryable']).toBe(false);
  expect(error['request_id']).toMatch(REQUEST_ID_PATTERN);
  expect(response.body).not.toContain('FST_ERR');
  expect(response.body).not.toContain('Client Error');
}

describe('framework and parser rejections use the public envelope', () => {
  let app: NestFastifyApplication;
  let log: CapturedLog;
  let port: number;

  beforeAll(async () => {
    log = new CapturedLog();
    const moduleBuilder = Test.createTestingModule({ imports: [AppModule] });
    moduleBuilder.overrideProvider(RUNTIME_CONNECTION_CONFIGURATION).useValue({
      databaseUrl: undefined,
      controlPlaneDatabaseUrl: undefined,
      controlPlaneReadDatabaseUrl: undefined,
      emailDailyBudgetDatabaseUrl: undefined,
      redisUrl: undefined,
      sandboxAssertionPrivateKey: undefined,
      sandboxAssertionKeyId: undefined,
    });
    moduleBuilder
      .overrideProvider(appConfig.KEY)
      .useValue({
        ...appConfig(),
        NODE_ENV: 'test',
        AIHUB_ALLOW_UNAUTHENTICATED_DEV: true,
      })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(testApiKeyAuthenticator)
      // The invalid-body case must reach the body parser, not a missing Redis.
      .overrideProvider(GRADED_ADMISSION)
      .useValue({ consume: async () => ({ stage: 'admitted' }) })
      .overrideProvider(QUOTA_COUNTER)
      .useValue({
        read: () => Promise.resolve(0),
        increment: () => Promise.resolve(),
      })
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => ({
          allowed: true,
          lease: { release: async () => undefined },
        }),
      });
    const moduleRef = await moduleBuilder.compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        // The same handler pair the production bootstrap installs.
        ...createAppFastifyErrorOptions(writeRequestCompletion),
        ...createRequestLogging(log, 'info'),
        trustProxy: '127.0.0.1',
        genReqId: () => generateRequestId(),
      }),
      { bufferLogs: true },
    );
    const fastify = app.getHttpAdapter().getInstance();
    registerRequestHooks(fastify, undefined);
    await app.init();
    await fastify.ready();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    log.reset();
  });

  it('pins the envelope for every rejection in the seven-row table', async () => {
    const invalidJson = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY_VALUE,
      },
      payload: '{',
    });
    expectEnvelope(invalidJson, 400, 'INVALID_REQUEST');

    const textBody = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'content-type': 'text/plain',
        'x-api-key': API_KEY_VALUE,
      },
      payload: 'hello',
    });
    expectEnvelope(textBody, 400, 'INVALID_REQUEST');

    const wrongMethod = await app.inject({
      method: 'DELETE',
      url: GRADE_URL,
    });
    expectEnvelope(wrongMethod, 404, 'NOT_FOUND');

    const unknownRoute = await app.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
    });
    expectEnvelope(unknownRoute, 404, 'NOT_FOUND');

    const longPath = await app.inject({
      method: 'GET',
      url: `/v1/${'a'.repeat(9_000)}`,
    });
    expectEnvelope(longPath, 404, 'NOT_FOUND');

    const polluted = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY_VALUE,
      },
      payload: '{"__proto__":{"polluted":true}}',
    });
    expectEnvelope(polluted, 400, 'INVALID_REQUEST');

    const badUrl = await app.inject({
      method: 'GET',
      url: '/v1/%E0%A4%A',
    });
    const response = expectEnvelope(badUrl, 400, 'INVALID_REQUEST');
    expect(response.message).toBe('Request failed validation');
    expect(JSON.stringify(badUrl.json())).not.toContain('%E0%A4%A');
    expect(JSON.stringify(badUrl.json())).not.toContain('FST_ERR');
  });

  it('writes one bounded completion event for a malformed URL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/%E0%A4%A',
    });
    const requestId = expectEnvelope(
      response,
      400,
      'INVALID_REQUEST',
    ).requestId;
    const completions = log.completions();

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      request_id: requestId,
      route: 'unmatched',
      http_status: 400,
      error_code: 'INVALID_REQUEST',
    });
    expect(JSON.stringify(completions[0])).not.toContain('%E0%A4%A');
  });

  it.each([
    [
      'NUL in a header',
      'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Bad: a\u0000b\r\n\r\n',
      400,
    ],
    ['malformed request line', 'GARBAGE\r\n\r\n', 400],
    [
      'oversized header',
      `GET /health HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`,
      431,
    ],
  ])(
    'answers a parser rejection (%s) with the envelope',
    async (_name, bytes, status) => {
      const response = await rawRequest(port, bytes);
      expect(response.status).toBe(status);
      expectRawEnvelope(response, status);
    },
  );

  it('answers a request timeout with the envelope', async () => {
    const response = parseRawResponse(
      await captureClientError('ERR_HTTP_REQUEST_TIMEOUT'),
    );
    expect(response.status).toBe(408);
    expectRawEnvelope(response, 408);
  });
});
