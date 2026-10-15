import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import { appConfig } from '@/config/runtime-configuration';
import { SandboxDemoKeyValidationResponseSchema } from '@/contracts/sandbox/demo-key-validation';
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

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

describe('Sandbox demo key validation HTTP flow', () => {
  let app: NestFastifyApplication;
  let hostConfig: Record<string, unknown>;
  let authenticated: AuthenticatedApiKey;
  let activeConfig: OrganizationIdentityConfig | null;
  let configReadFailure: Error | null;
  let keysIssued = 0;

  beforeAll(async () => {
    const authenticator: ApiKeyAuthenticatorPort = {
      authenticate: async () => authenticated,
    };
    const budget: SandboxDispatchBudgetPort = {
      // Validation reserves nothing, so reaching this is a test failure on its
      // own; no counter is needed to notice it.
      reserve: async () => {
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

    // The selected environment is derived from the serving host, so each case
    // points that host at the environment its request selects.
    hostConfig = {
      ...appConfig(),
      NODE_ENV: 'test',
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: false,
      AIHUB_SANDBOX_HOST: 'localhost',
      AIHUB_PRODUCTION_HOST: undefined,
      AIHUB_STAGING_HOST: undefined,
      AIHUB_DEVELOPMENT_HOST: undefined,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(appConfig.KEY)
      .useValue(hostConfig)
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
    hostConfig.AIHUB_SANDBOX_HOST = 'localhost';
    hostConfig.AIHUB_PRODUCTION_HOST = undefined;
    // A key per case, so the per-key rate limit cannot couple these cases.
    keysIssued += 1;
    authenticated = {
      ...authenticatedApiKey,
      apiKeyId: `ak_demo_${keysIssued}`,
    };
    activeConfig = null;
    configReadFailure = null;
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

  /** The validated `data` object, proven against the published schema. */
  function validatedData(response: {
    statusCode: number;
    json(): unknown;
  }): Record<string, unknown> {
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data?: unknown };
    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    // The whole response matches the closed contract, so an extra or an
    // unspecified field fails here rather than reaching the browser.
    expect(Value.Check(SandboxDemoKeyValidationResponseSchema, body.data)).toBe(
      true,
    );
    return body.data as Record<string, unknown>;
  }

  /** A refusal envelope carries no `data`, so no identity mode escapes with it. */
  function refusal(
    response: { statusCode: number; json(): unknown },
    status: number,
  ) {
    expect(response.statusCode).toBe(status);
    const body = response.json() as ErrorBody;
    expect(Object.keys(body)).toEqual(['error']);
    return body.error;
  }

  it('reports declared_id for an Organization without active Identity Configuration', async () => {
    const data = validatedData(await validate({ scope: 'speaking.grade' }));

    expect(data).toMatchObject({
      valid: true,
      environment: 'sandbox',
      scope: 'speaking.grade',
      user_identity_mode: 'declared_id',
      allowance: { monthly_limit: 5, reserved: 0 },
    });
  });

  it('admits an Organization with active Identity Configuration and reports signed_assertion', async () => {
    activeConfig = identityConfig;

    const data = validatedData(await validate({ scope: 'writing.grade' }));

    expect(data).toMatchObject({
      valid: true,
      scope: 'writing.grade',
      user_identity_mode: 'signed_assertion',
    });
  });

  it('applies the same identity mode to a Production selection with no allowance', async () => {
    activeConfig = identityConfig;
    hostConfig.AIHUB_SANDBOX_HOST = undefined;
    hostConfig.AIHUB_PRODUCTION_HOST = 'localhost';
    authenticated = {
      ...authenticatedApiKey,
      environment: 'production',
      allowedEnvironments: ['production'],
    };

    const data = validatedData(
      await validate({ scope: 'speaking.grade', environment: 'production' }),
    );

    expect(data).toMatchObject({
      environment: 'production',
      user_identity_mode: 'signed_assertion',
      allowance: null,
    });
  });

  it('refuses an environment the key is not bound to without reporting a mode', async () => {
    const error = refusal(
      await validate({ scope: 'speaking.grade', environment: 'production' }),
      403,
    );

    expect(error).toMatchObject({ code: 'FORBIDDEN', retryable: false });
  });

  it('refuses a scope the key does not carry without reporting a mode', async () => {
    authenticated = {
      ...authenticated,
      scopes: ['writing.grade'],
    };

    const error = refusal(await validate({ scope: 'speaking.grade' }), 403);

    expect(error).toMatchObject({ code: 'FORBIDDEN', retryable: false });
  });

  it('fails closed and retryable when the identity configuration cannot be read', async () => {
    configReadFailure = new Error('connection terminated');

    const error = refusal(await validate({ scope: 'speaking.grade' }), 503);

    expect(error).toMatchObject({
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});
