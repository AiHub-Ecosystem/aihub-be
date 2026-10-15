import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import { appConfig } from '@/config/runtime-configuration';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/application/web-session-client-secret.port';
import { SANDBOX_DISPATCH_BUDGET } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/public/sandbox-dispatch-budget';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type AuthenticatedApiKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfig,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';

const DEMO_ORG = 'org_demo';

const identityConfig: OrganizationIdentityConfig = {
  organizationId: DEMO_ORG,
  issuer: 'https://sandbox.aihub.example.com',
  jwksUrl: null,
  publicKeysJwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
  allowedAlgorithms: ['RS256'],
  maxAssertionTtlSeconds: 3_600,
  status: 'active',
};

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: DEMO_ORG,
  apiKeyId: 'ak_demo',
  environment: 'sandbox',
  scopes: ['writing.grade', 'speaking.grade'],
  rateLimitRpm: 60,
  maxConcurrent: 3,
  monthlyRequestQuota: 500,
  hardStopOnQuota: true,
  allowedEnvironments: ['sandbox'],
};

describe('Sandbox demo key validation HTTP flow', () => {
  let app: NestFastifyApplication;
  let authenticated: AuthenticatedApiKey;
  let activeConfig: OrganizationIdentityConfig | null;
  let configReadFailure: Error | null;
  let reservations: number;

  beforeAll(async () => {
    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => authenticated,
    };
    const budget: SandboxDispatchBudgetPort = {
      // Validation reserves nothing, so a reservation here is a test failure.
      reserve: async () => {
        reservations += 1;
        throw new Error('validation must never reserve a dispatch');
      },
      release: async () => undefined,
      allowanceFor: async () => ({
        monthlyLimit: 5,
        reserved: 0,
        sharedMonthlyLimit: 500,
        sharedReserved: 0,
      }),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(appConfig.KEY)
      .useValue({
        ...appConfig(),
        NODE_ENV: 'test',
        AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
        // The demo selects Sandbox, so the serving host must resolve to it.
        AIHUB_SANDBOX_HOST: 'localhost',
        AIHUB_STAGING_HOST: undefined,
        AIHUB_PRODUCTION_HOST: undefined,
        AIHUB_DEVELOPMENT_HOST: undefined,
      })
      .overrideProvider(WEB_SESSION_CLIENT_SECRET)
      .useValue({ resolve: () => 'test-bff-client-secret' })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(SANDBOX_DISPATCH_BUDGET)
      .useValue(budget)
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue({
        findActiveByOrganizationId: async () => {
          if (configReadFailure !== null) throw configReadFailure;
          return activeConfig;
        },
      })
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
    authenticated = { ...authenticatedApiKey };
    activeConfig = null;
    configReadFailure = null;
    reservations = 0;
  });

  function validate(payload: Readonly<Record<string, unknown>>) {
    return app.inject({
      method: 'POST',
      url: '/v1/sandbox/demo/api-keys/validate',
      headers: {
        host: 'localhost',
        'x-api-key': 'test-api-key',
        'x-aihub-client-secret': 'test-bff-client-secret',
        'x-aihub-visitor-ip': '203.0.113.7',
      },
      payload,
    });
  }

  it('reports declared_id for an Organization without active Identity Configuration', async () => {
    const response = await validate({ scope: 'speaking.grade' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      data: {
        valid: true,
        environment: 'sandbox',
        scope: 'speaking.grade',
        user_identity_mode: 'declared_id',
        allowance: { monthly_limit: 5, reserved: 0 },
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    // The signal carries no Identity Configuration detail.
    expect(JSON.stringify(body)).not.toContain('issuer');
    expect(JSON.stringify(body)).not.toContain('jwks');
    expect(reservations).toBe(0);
  });

  it('admits an Organization with active Identity Configuration and reports signed_assertion', async () => {
    activeConfig = identityConfig;

    const response = await validate({ scope: 'writing.grade' });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      data: { valid: true, user_identity_mode: 'signed_assertion' },
    });
    expect(JSON.stringify(body)).not.toContain('issuer');
    expect(JSON.stringify(body)).not.toContain('jwks');
    expect(reservations).toBe(0);
  });

  it('refuses an environment the key is not bound to without reporting a mode', async () => {
    const response = await validate({
      scope: 'speaking.grade',
      environment: 'production',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('data');
  });

  it('refuses a scope the key does not carry without reporting a mode', async () => {
    authenticated = { ...authenticatedApiKey, scopes: ['writing.grade'] };

    const response = await validate({ scope: 'speaking.grade' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('data');
  });

  it('fails closed and retryable when the identity configuration cannot be read', async () => {
    configReadFailure = new Error('connection terminated');

    const response = await validate({ scope: 'speaking.grade' });

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain('declared_id');
  });
});
