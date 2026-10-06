import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { exportPKCS8, generateKeyPair } from 'jose';

import { AppModule } from '@/app.module';
import { AppError } from '@/common/errors/app-error';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  appConfig,
  getRuntimeConnectionConfiguration,
} from '@/config/runtime-configuration';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '@/modules/identity/application/api-key-authenticator.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfig,
} from '@/modules/identity/application/organization-identity-config-repository.port';
import { RUNTIME_CONNECTION_CONFIGURATION } from '@/modules/secrets/application/runtime-connection-configuration.port';

const SANDBOX_ORG = 'org_sandbox';

const identityConfig: OrganizationIdentityConfig = {
  organizationId: SANDBOX_ORG,
  issuer: 'https://sandbox.aihub.example.com',
  jwksUrl: null,
  publicKeysJwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
  allowedAlgorithms: ['RS256'],
  maxAssertionTtlSeconds: 3_600,
  status: 'active',
};

let authenticatedApiKey: AuthenticatedApiKey;
let authenticationError: AppError | undefined;
type TestRuntimeConfiguration = {
  -readonly [Key in keyof ReturnType<typeof appConfig>]: ReturnType<
    typeof appConfig
  >[Key];
};

describe('Sandbox assertion HTTP flow', () => {
  let app: NestFastifyApplication;
  let runtimeConfiguration: TestRuntimeConfiguration;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    runtimeConfiguration = {
      ...appConfig(),
      NODE_ENV: 'test',
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
      AIHUB_SANDBOX_ORG_IDS: SANDBOX_ORG,
    };
    const runtimeConnection = {
      ...getRuntimeConnectionConfiguration(),
      sandboxAssertionPrivateKey: await exportPKCS8(privateKey),
      sandboxAssertionKeyId: 'sandbox-2026-09',
    };

    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => {
        if (authenticationError !== undefined) {
          throw authenticationError;
        }

        return authenticatedApiKey;
      },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(appConfig.KEY)
      .useValue(runtimeConfiguration)
      .overrideProvider(RUNTIME_CONNECTION_CONFIGURATION)
      .useValue(runtimeConnection)
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue({ findActiveByOrganizationId: async () => identityConfig })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    authenticationError = undefined;
    runtimeConfiguration.AIHUB_SANDBOX_ORG_IDS = SANDBOX_ORG;
    authenticatedApiKey = {
      organizationId: SANDBOX_ORG,
      apiKeyId: 'ak_sandbox',
      environment: 'development',
      scopes: ['speaking.grade'],
      rateLimitRpm: 60,
      maxConcurrent: 3,
      monthlyRequestQuota: 500,
      hardStopOnQuota: true,
    };
  });

  function mint(payload: Readonly<Record<string, unknown>>) {
    return app.inject({
      method: 'POST',
      url: '/v1/sandbox/assertions',
      headers: { host: 'localhost', 'x-api-key': 'test-api-key' },
      payload,
    });
  }

  it('returns an assertion and its expiry, with the request id', async () => {
    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      data: {
        user_id: 'student_456',
        expires_at: expect.any(Number),
        assertion: expect.any(String),
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
  });

  it('rejects a request with no api key through the shared authenticator', async () => {
    authenticationError = new AppError({
      code: 'UNAUTHORIZED',
      message: 'API key is invalid',
      retryable: false,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sandbox/assertions',
      headers: { host: 'localhost' },
      payload: { user_id: 'student_456' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
  });

  // The assertion is a credential: one written to a log file outlives the
  // request that produced it.
  it('logs who minted what, and never the token itself', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      logged.push(String(message));
    });

    const response = await mint({ user_id: 'student_456' });
    const body = response.json<{ data: { assertion: string } }>();
    const line = logged.find((entry) =>
      entry.includes('sandbox_assertion_minted'),
    );

    expect(line).toBeDefined();
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      event: 'sandbox_assertion_minted',
      requestId: expect.stringMatching(/^req_/),
      organizationId: SANDBOX_ORG,
      apiKeyId: 'ak_sandbox',
      userId: 'student_456',
      jti: expect.any(String),
    });
    expect(line).not.toContain(body.data.assertion);
    expect(line).not.toContain('PRIVATE KEY');
  });

  it('rejects a key outside the sandbox allowlist', async () => {
    authenticatedApiKey = {
      ...authenticatedApiKey,
      organizationId: 'org_acme',
    };

    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });

  it.each([
    ['a missing user id', {}],
    ['an unknown property', { user_id: 'student_456', exp: 99 }],
    ['a disallowed character', { user_id: 'student 456' }],
    ['a non-string user id', { user_id: 42 }],
  ])('rejects %s', async (_label, payload) => {
    const response = await mint(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  // An unconfigured deployment must look like one that never had the route.
  it('answers 404 when no sandbox is configured', async () => {
    runtimeConfiguration.AIHUB_SANDBOX_ORG_IDS = '';

    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('never returns the signing key or the caller api key', async () => {
    const response = await mint({ user_id: 'student_456' });

    expect(response.body).not.toContain('PRIVATE KEY');
    expect(response.body).not.toContain('test-api-key');
  });

  it('applies the rate limit the api key carries', async () => {
    authenticatedApiKey = { ...authenticatedApiKey, rateLimitRpm: 0 };

    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});
