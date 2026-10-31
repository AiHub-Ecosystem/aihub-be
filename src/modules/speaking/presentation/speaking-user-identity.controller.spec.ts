import providerResponse from '../../../../test/fixtures/ai-speaking/grading.response.json';

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
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { API_KEY_AUTHENTICATOR } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { ORGANIZATION_IDENTITY_CONFIG_REPOSITORY } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { DISPATCH_ATTEMPT_RECORD } from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { registerSpeakingMultipartParser } from '@/modules/speaking/infrastructure/fastify-speaking-multipart.parser';

const FIXTURE_URL = 'https://ai-speaking.test';
const multipartUrl = '/v1/ielts/speaking/grading';
const jsonUrl = '/v1/ielts/speaking/grading-json';
const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_test',
  environment: 'test',
  scopes: ['speaking.grade'],
  rateLimitRpm: 60,
  maxConcurrent: 2,
  monthlyRequestQuota: null,
  hardStopOnQuota: true,
  allowedEnvironments: ['test'],
};

type CapturedBody = Record<string, unknown> | UndiciFormData;

interface CapturedOutboundRequest {
  readonly operation: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: CapturedBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBody(value: unknown): Record<string, unknown> {
  const parsed: unknown =
    typeof value === 'string'
      ? JSON.parse(value)
      : value instanceof Uint8Array
        ? JSON.parse(new TextDecoder().decode(value))
        : undefined;
  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON Speaking request body');
  }
  return parsed;
}

function multipartPayload(fields: Readonly<Record<string, string>>): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = '----aihub-user-identity-boundary';
  const parts = Object.entries(fields).map(([name, value]) =>
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
    Buffer.alloc(200, 1),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function apiKeyHeaders(identity?: string): Record<string, string> {
  return {
    host: 'localhost',
    'x-api-key': 'test-api-key',
    ...(identity === undefined ? {} : { 'x-user-identity': identity }),
  };
}

describe('Speaking user identity HTTP flow', () => {
  let app: NestFastifyApplication;
  let mockAgent: MockAgent;
  let outboundRequests: CapturedOutboundRequest[];
  const originalEnv = {
    nodeEnv: process.env.NODE_ENV,
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    speakingUrl: process.env.DOWNSTREAM_AI_SPEAKING_URL,
    speakingClientId: process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID,
    speakingSecret: process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY,
  };

  const authenticator: ApiKeyAuthenticatorPort = {
    authenticate: async () => authenticatedApiKey,
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';
    process.env.DOWNSTREAM_AI_SPEAKING_URL = FIXTURE_URL;
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = 'speaking-client';
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = 'speaking-secret';
    outboundRequests = [];
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();

    const multipartHeaders: Array<Readonly<Record<string, string>>> = [];
    const jsonHeaders: Array<Readonly<Record<string, string>>> = [];
    mockAgent
      .get(FIXTURE_URL)
      .intercept({
        method: 'POST',
        path: '/api/v1/speaking/grading',
        headers: (headers) => {
          multipartHeaders.push({ ...headers });
          return true;
        },
      })
      .reply((request) => {
        const headers = multipartHeaders.at(-1);
        if (
          headers === undefined ||
          !(request.body instanceof UndiciFormData)
        ) {
          throw new Error('Expected an intercepted multipart Speaking request');
        }
        outboundRequests.push({
          operation: 'speaking.grading',
          headers,
          body: request.body,
        });
        return { statusCode: 200, data: providerResponse };
      })
      .persist();
    mockAgent
      .get(FIXTURE_URL)
      .intercept({
        method: 'POST',
        path: '/api/v1/speaking/grading-json',
        headers: (headers) => {
          jsonHeaders.push({ ...headers });
          return true;
        },
      })
      .reply((request) => {
        const headers = jsonHeaders.at(-1);
        if (headers === undefined) {
          throw new Error('Expected an intercepted JSON Speaking request');
        }
        outboundRequests.push({
          operation: 'speaking.grading-json',
          headers,
          body: jsonBody(request.body),
        });
        return { statusCode: 200, data: providerResponse };
      })
      .persist();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue({ findActiveByOrganizationId: async () => null })
      .overrideProvider(DownstreamHttpClient)
      .useValue(
        new DownstreamHttpClient(
          { 'ai-speaking': FIXTURE_URL, 'ai-writing': FIXTURE_URL },
          mockAgent,
          {
            'ai-speaking': {
              'x-client-id': 'speaking-client',
              'x-secret-key': 'speaking-secret',
            },
          },
        ),
      )
      .overrideProvider(DISPATCH_ATTEMPT_RECORD)
      .useValue(noOpDispatchAttemptRecord)
      .overrideProvider(GRADED_ADMISSION)
      .useValue({ consume: async () => ({ stage: 'admitted' }) })
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => ({
          allowed: true,
          lease: { release: async () => undefined },
        }),
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerSpeakingMultipartParser(app.getHttpAdapter().getInstance());
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    registerSecurityHeaders(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    process.env.NODE_ENV = originalEnv.nodeEnv;
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.DOWNSTREAM_AI_SPEAKING_URL = originalEnv.speakingUrl;
    process.env.DOWNSTREAM_AI_SPEAKING_CLIENT_ID = originalEnv.speakingClientId;
    process.env.DOWNSTREAM_AI_SPEAKING_SECRET_KEY = originalEnv.speakingSecret;
  });

  beforeEach(() => {
    outboundRequests = [];
  });

  it.each([
    ['missing', undefined, 'USER_IDENTITY_REQUIRED'],
    ['blank', '', 'INVALID_USER_IDENTITY'],
  ] as const)(
    'rejects a %s X-User-Identity on both routes before any Speaking call',
    async (_name, identity, code) => {
      for (const [url, payload, contentType] of [
        [
          multipartUrl,
          multipartPayload({ part: '1', question_id: 'q1' }).payload,
          'multipart/form-data; boundary=----aihub-user-identity-boundary',
        ],
        [
          jsonUrl,
          {
            audio_url: 'https://s3.wispace.app/audio/a.wav',
            part: 1,
            question_id: 'q1',
          },
          'application/json',
        ],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { ...apiKeyHeaders(identity), 'content-type': contentType },
          payload,
        });

        expect(response.statusCode).toBe(401);
        expect(response.json<unknown>()).toMatchObject({ error: { code } });
        expect(outboundRequests).toHaveLength(0);
      }
    },
  );

  it('ignores spoofed identity headers and derives both outbound identities from server context', async () => {
    const spoofedHeaders = {
      'x-aihub-organization-id': 'org_spoofed',
      'x-aihub-user-id': 'spoofed-user',
      'x-aihub-user-identity-mode': 'signed_assertion',
      'x-organization-id': 'org_spoofed',
      'x-user-id': 'spoofed-user',
    };
    const multipart = multipartPayload({ part: '1', question_id: 'q1' });
    const multipartResponse = await app.inject({
      method: 'POST',
      url: multipartUrl,
      headers: {
        ...apiKeyHeaders('same_end_user'),
        ...spoofedHeaders,
        'content-type': multipart.contentType,
      },
      payload: multipart.payload,
    });
    const jsonResponse = await app.inject({
      method: 'POST',
      url: jsonUrl,
      headers: {
        ...apiKeyHeaders('same_end_user'),
        ...spoofedHeaders,
        'content-type': 'application/json',
      },
      payload: {
        audio_url: 'https://s3.wispace.app/audio/a.wav',
        part: 1,
        question_id: 'q1',
      },
    });

    expect(multipartResponse.statusCode).toBe(200);
    expect(jsonResponse.statusCode).toBe(200);
    expect(outboundRequests).toHaveLength(2);
    for (const outbound of outboundRequests) {
      expect(outbound.headers).toMatchObject({
        'x-aihub-organization-id': 'org_acme',
        'x-aihub-user-id': 'same_end_user',
        'x-aihub-user-identity-mode': 'declared_id',
      });
      // Per header: a whole-object `not.toMatchObject` passes when only one
      // of several spoofed values differs.
      for (const [name, spoofed] of Object.entries(spoofedHeaders)) {
        expect(outbound.headers[name]).not.toBe(spoofed);
      }
    }
    expect(
      outboundRequests.map(({ body }) =>
        body instanceof UndiciFormData ? body.get('user_id') : body.user_id,
      ),
    ).toEqual(['same_end_user', 'same_end_user']);
    expect(
      outboundRequests.map(({ body }) =>
        body instanceof UndiciFormData
          ? body.get('organization_id')
          : body.organization_id,
      ),
    ).toEqual([null, undefined]);
  });

  it('rejects customer organization_id and user_id fields on both request bodies', async () => {
    const multipart = multipartPayload({
      part: '1',
      question_id: 'q1',
      organization_id: 'org_spoofed',
      user_id: 'spoofed-user',
    });
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: multipartUrl,
        headers: {
          ...apiKeyHeaders('same_end_user'),
          'content-type': multipart.contentType,
        },
        payload: multipart.payload,
      }),
      app.inject({
        method: 'POST',
        url: jsonUrl,
        headers: {
          ...apiKeyHeaders('same_end_user'),
          'content-type': 'application/json',
        },
        payload: {
          audio_url: 'https://s3.wispace.app/audio/a.wav',
          part: 1,
          question_id: 'q1',
          organization_id: 'org_spoofed',
          user_id: 'spoofed-user',
        },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(outboundRequests).toHaveLength(0);
  });
});
