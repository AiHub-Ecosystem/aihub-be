import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { generateRequestId } from '../../../common/request-context/request-id';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '../application/api-key-authenticator.port';

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'development',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

/**
 * A deployment that never wanted a sandbox is the common case, and it must be
 * completely unaffected by this feature existing.
 *
 * This boots with the sandbox variables genuinely absent, unlike the
 * configured suite, which sets them before `AppModule` is created. That
 * distinction matters: the signer resolves its key on first use rather than at
 * construction, and only a cold start with nothing configured proves the
 * module graph assembles without it.
 */
describe('Sandbox assertions on a deployment with none configured', () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';
    for (const name of [
      'AIHUB_SANDBOX_ORG_IDS',
      'AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY',
      'AIHUB_SANDBOX_ASSERTION_KID',
    ]) {
      Reflect.deleteProperty(process.env, name);
    }

    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => authenticatedApiKey,
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
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

  it('starts and serves the rest of the application', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('answers 404 on the mint route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sandbox/assertions',
      headers: { host: 'localhost', 'x-api-key': 'test-api-key' },
      payload: { user_id: 'student_456' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  // Half a configuration cannot sign anything, so it must not open the route
  // and then fail at the last step.
  it('still answers 404 when only the allowlist is set', async () => {
    process.env.AIHUB_SANDBOX_ORG_IDS = 'org_acme';

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sandbox/assertions',
        headers: { host: 'localhost', 'x-api-key': 'test-api-key' },
        payload: { user_id: 'student_456' },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      Reflect.deleteProperty(process.env, 'AIHUB_SANDBOX_ORG_IDS');
    }
  });
});
