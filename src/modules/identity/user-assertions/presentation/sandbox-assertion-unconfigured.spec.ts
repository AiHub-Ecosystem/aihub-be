import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { useTestRuntimeConfiguration } from '../../../../../test/support/test-runtime-configuration';

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'development',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
  allowedEnvironments: ['sandbox'],
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
const SANDBOX_UNSET = {
  AIHUB_SANDBOX_ORG_IDS: undefined,
  AIHUB_SANDBOX_ASSERTION_PRIVATE_KEY: undefined,
  AIHUB_SANDBOX_ASSERTION_KID: undefined,
};

/** Boots the application from an explicit runtime configuration. */
async function bootApp(
  overrides: Readonly<Record<string, string | undefined>>,
): Promise<NestFastifyApplication> {
  useTestRuntimeConfiguration({
    AIHUB_ALLOW_UNAUTHENTICATED_DEV: 'false',
    ...SANDBOX_UNSET,
    ...overrides,
  });
  const authenticator: ApiKeyAuthenticatorPort = {
    authenticate: async () => authenticatedApiKey,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_KEY_AUTHENTICATOR)
    .useValue(authenticator)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => generateRequestId() }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const mintRoute = {
  method: 'POST',
  url: '/v1/sandbox/assertions',
  headers: { host: 'localhost', 'x-api-key': 'test-api-key' },
  payload: { user_id: 'student_456' },
} as const;

describe('Sandbox assertions on a deployment with none configured', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await bootApp({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts and serves the rest of the application', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('answers 404 on the mint route', async () => {
    const response = await app.inject(mintRoute);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

// Half a configuration cannot sign anything, so it must not open the route
// and then fail at the last step. The application boots from that half
// configuration: the runtime snapshot is fixed at boot, so setting the
// variable on a running application would test nothing.
describe('Sandbox assertions with only the allowlist configured', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await bootApp({ AIHUB_SANDBOX_ORG_IDS: 'org_acme' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('still answers 404 on the mint route', async () => {
    const response = await app.inject(mintRoute);

    expect(response.statusCode).toBe(404);
  });
});
