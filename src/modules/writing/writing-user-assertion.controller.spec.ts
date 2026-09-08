import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { AppModule } from '../../app.module';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/request-context/request-context';
import { generateRequestId } from '../../common/request-context/request-id';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from '../gateway/application/operation-dispatcher.port';
import { OPERATION_DISPATCHER } from '../gateway/application/operation-dispatcher.port';
import type { RateLimiterPort } from '../gateway/application/rate-limiter.port';
import { RATE_LIMITER } from '../gateway/application/rate-limiter.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '../idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '../idempotency/application/idempotency-service.port';
import type {
  ApiKeyAuthenticatorPort,
  AuthenticatedApiKey,
} from '../identity/application/api-key-authenticator.port';
import { API_KEY_AUTHENTICATOR } from '../identity/application/api-key-authenticator.port';
import type { JwksKeyProviderPort } from '../identity/application/jwks-key-provider.port';
import { JWKS_KEY_PROVIDER } from '../identity/application/jwks-key-provider.port';
import type { OrganizationIdentityConfig } from '../identity/application/organization-identity-config-repository.port';
import { ORGANIZATION_IDENTITY_CONFIG_REPOSITORY } from '../identity/application/organization-identity-config-repository.port';

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'development',
  scopes: ['writing.grade', 'writing.question.generate'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

const gradePayload = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'The chart shows a clear trend.',
  image_url: 'https://example.com/chart.png',
};

describe('Writing user assertion HTTP flow', () => {
  let app: NestFastifyApplication;
  let privateKey: unknown;
  let publicJwk: Record<string, unknown>;
  let capturedContext: RequestContext | undefined;
  let identityConfig: OrganizationIdentityConfig;
  let providerUnavailable = false;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBypass = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;

  const configRepository = {
    findActiveByOrganizationId: async () => identityConfig,
  };
  const keyProvider: JwksKeyProviderPort = {
    resolve: async () => {
      if (providerUnavailable) {
        throw new AppError({
          code: 'IDENTITY_PROVIDER_UNAVAILABLE',
          message: 'Identity provider is unavailable',
          retryable: true,
        });
      }

      return { keys: [publicJwk] };
    },
  };
  const authenticator: ApiKeyAuthenticatorPort = {
    authenticate: async () => authenticatedApiKey,
  };
  const limiter: RateLimiterPort = {
    consume: async () => ({ allowed: true }),
  };
  const dispatcher: OperationDispatcherPort = {
    dispatch: async (
      operation: 'writing.task1.grade',
      _input: typeof gradePayload,
      context: RequestContext,
    ): Promise<DispatchResult<unknown>> => {
      capturedContext = context;
      return {
        operation,
        data: {},
        downstreamMs: 0,
      };
    },
  } as unknown as OperationDispatcherPort;
  const idempotencyService: IdempotencyServicePort = {
    async execute<T>(
      _input: IdempotencyExecutionInput,
      work: IdempotencyWork<T>,
      _decodeReplay: IdempotencyReplayDecoder<T>,
    ): Promise<IdempotencyExecution<T>> {
      return {
        result: await work({
          signal: AbortSignal.timeout(60_000),
          deadlineAt: new Date(Date.now() + 60_000),
        }),
        replay: false,
      };
    },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';
    const generated = await generateKeyPair('RS256');
    privateKey = generated.privateKey;
    publicJwk = {
      ...(await exportJWK(generated.publicKey)),
      alg: 'RS256',
      kid: 'rsa-1',
    };
    identityConfig = {
      organizationId: 'org_acme',
      issuer: 'https://acme.edu',
      jwksUrl: null,
      publicKeysJwks: { keys: [publicJwk] },
      allowedAlgorithms: ['RS256'],
      maxAssertionTtlSeconds: 300,
      status: 'active',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(RATE_LIMITER)
      .useValue(limiter)
      .overrideProvider(OPERATION_DISPATCHER)
      .useValue(dispatcher)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotencyService)
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue(configRepository)
      .overrideProvider(JWKS_KEY_PROVIDER)
      .useValue(keyProvider)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    process.env.NODE_ENV = originalNodeEnv;
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalBypass;
  });

  beforeEach(() => {
    capturedContext = undefined;
    providerUnavailable = false;
    identityConfig = {
      ...identityConfig,
      jwksUrl: null,
      publicKeysJwks: { keys: [publicJwk] },
    };
  });

  async function assertion(
    options: {
      readonly issuer?: string;
      readonly expiration?: number;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(options.issuer ?? identityConfig.issuer)
      .setAudience('aihub')
      .setSubject('user_123')
      .setIssuedAt(now - 10)
      .setExpirationTime(options.expiration ?? now + 100)
      .setJti('jti-http-1')
      .sign(privateKey as never);
  }

  function apiKeyHeaders(assertionValue?: string): Record<string, string> {
    return {
      host: 'localhost',
      'x-api-key': 'test-api-key',
      'idempotency-key': 'user-assertion-test',
      ...(assertionValue === undefined
        ? {}
        : { 'x-user-assertion': assertionValue }),
    };
  }

  it('rejects missing Task 1 and Task 2 assertions before dispatch', async () => {
    for (const url of ['/v1/writing/task1/grade', '/v1/writing/task2/grade']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: apiKeyHeaders(),
        payload: gradePayload,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('USER_ASSERTION_REQUIRED');
      expect(capturedContext).toBeUndefined();
    }
  });

  it('verifies a valid assertion, binds its actor, and keeps it out of the dispatch body', async () => {
    const signed = await assertion();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/grade',
      headers: apiKeyHeaders(signed),
      payload: gradePayload,
    });

    expect(response.statusCode).toBe(200);
    expect(capturedContext).toMatchObject({
      organizationId: 'org_acme',
      userId: 'user_123',
    });
  });

  it.each([
    ['cross-tenant', { issuer: 'https://other.example' }],
    ['expired', { expiration: Math.floor(Date.now() / 1_000) - 61 }],
  ])('rejects %s assertions without dispatching', async (_name, options) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/grade',
      headers: apiKeyHeaders(await assertion(options)),
      payload: gradePayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_USER_ASSERTION');
    expect(capturedContext).toBeUndefined();
  });

  it('returns the provider-unavailable error without exposing provider details', async () => {
    providerUnavailable = true;
    identityConfig = {
      ...identityConfig,
      jwksUrl: 'https://id.acme.edu/.well-known/jwks.json',
      publicKeysJwks: null,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/grade',
      headers: apiKeyHeaders(await assertion()),
      payload: gradePayload,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'IDENTITY_PROVIDER_UNAVAILABLE',
        message: 'Identity provider is unavailable',
        request_id: expect.stringMatching(/^req_/),
        retryable: true,
      },
    });
    expect(response.payload).not.toContain('provider down');
  });

  it('allows an organization-scoped request without an assertion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: apiKeyHeaders(),
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedContext?.organizationId).toBe('org_acme');
    expect(capturedContext?.userId).toBeUndefined();
  });

  it('still verifies an assertion supplied to an organization-scoped request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/writing/task1/questions',
      headers: apiKeyHeaders('not-a-jwt'),
      payload: { chart_type: 'Bar Chart' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_USER_ASSERTION');
  });
});
