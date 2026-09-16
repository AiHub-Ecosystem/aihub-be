import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { exportPKCS8, generateKeyPair } from 'jose';

import { AppModule } from '../../app.module';
import { generateRequestId } from '../../common/request-context/request-id';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from './application/api-key-authenticator.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfig,
} from './application/organization-identity-config-repository.port';

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

describe('Sandbox assertion HTTP flow', () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });

    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';
    process.env.AIHUB_SANDBOX_ORG_IDS = SANDBOX_ORG;
    process.env.AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY =
      await exportPKCS8(privateKey);
    process.env.AIHUB_SANDBOX_ASSERTION_KID = 'sandbox-2026-09';

    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => authenticatedApiKey,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    process.env = originalEnv;
  });

  beforeEach(() => {
    process.env.AIHUB_SANDBOX_ORG_IDS = SANDBOX_ORG;
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

  it('returns an assertion and its expiry', async () => {
    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      user_id: 'student_456',
      expires_at: expect.any(Number),
      assertion: expect.any(String),
    });
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
    process.env.AIHUB_SANDBOX_ORG_IDS = '';

    const response = await mint({ user_id: 'student_456' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('never returns the signing key or the caller api key', async () => {
    const response = await mint({ user_id: 'student_456' });

    expect(response.body).not.toContain('PRIVATE KEY');
    expect(response.body).not.toContain('test-api-key');
  });
});
