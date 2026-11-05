import { publicApiMajorV1 } from '@/catalog/public-api-major-v1.fixture';
import { Controller, Get } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from './app.module';
import { OPERATION_CATALOG } from './catalog/operation-catalog';
import {
  latestPublicApiMajor,
  supportedPublicApiMajors,
} from './catalog/public-api-majors';
import { PUBLIC_ROUTES } from './catalog/public-routes';
import { AppError } from './common/errors/app-error';
import { registerBodySizeGuard } from './common/http/body-size.hook';
import { generateRequestId } from './common/request-context/request-id';
import { USER_ACCOUNT_REPOSITORY } from './modules/auth/accounts/application/user-account.port';
import {
  NO_USER_ACCESS_TOKEN_REVOCATIONS,
  verifiedUserAccessToken,
} from './modules/auth/testing/user-access-token-verifier.stub';
import { USER_ACCESS_TOKEN_REVOCATION_RECORD } from './modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { USER_ACCESS_TOKEN_VERIFIER } from './modules/auth/web-sessions/application/user-access-token.port';
import { RUNTIME_CONNECTION_CONFIGURATION } from './modules/secrets/application/runtime-connection-configuration.port';
import { buildOpenApiDocument } from './openapi/build-openapi-document';

@Controller('boom')
class BoomController {
  @Get()
  throwAppError(): never {
    throw new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'AI service is temporarily unavailable',
      retryable: true,
    });
  }
}

interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

const OPENAPI_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);

const RequestIdEnvelopeSchema = Type.Object({
  error: Type.Object({
    request_id: Type.String({ pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' }),
  }),
});

function requestIdOf(response: { json(): unknown }): string {
  return Value.Parse(RequestIdEnvelopeSchema, response.json()).error.request_id;
}

function routeShape(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ||
      (segment.startsWith('{') && segment.endsWith('}'))
        ? '{}'
        : segment,
    )
    .join('/');
}

function missingPublicRoutes(
  registeredRoutes: readonly RegisteredRoute[],
  openApiDocument: unknown,
): string[] {
  const paths = (openApiDocument as { paths: Record<string, unknown> }).paths;
  const documentedRoutes = new Set<string>();

  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) {
      continue;
    }

    for (const method of Object.keys(pathItem)) {
      if (OPENAPI_METHODS.has(method)) {
        documentedRoutes.add(`${method.toUpperCase()} ${routeShape(path)}`);
      }
    }
  }

  return registeredRoutes
    .filter(({ url }) => url === '/v1' || url.startsWith('/v1/'))
    .map(({ method, url }) => `${method.toUpperCase()} ${routeShape(url)}`)
    .filter((route) => !documentedRoutes.has(route))
    .sort();
}

describe('AppModule wiring', () => {
  let app: NestFastifyApplication;
  const registeredRoutes: RegisteredRoute[] = [];
  const docsRoutes = [
    '/docs',
    '/openapi.json',
    ...supportedPublicApiMajors().map(({ major }) => `/openapi/v${major}.json`),
  ];

  beforeAll(async () => {
    const moduleBuilder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoomController],
    });
    moduleBuilder.overrideProvider(RUNTIME_CONNECTION_CONFIGURATION).useValue({
      databaseUrl: undefined,
      controlPlaneDatabaseUrl: undefined,
      controlPlaneReadDatabaseUrl: undefined,
      emailDailyBudgetDatabaseUrl: undefined,
      redisUrl: undefined,
      sandboxAssertionPrivateKey: undefined,
      sandboxAssertionKeyId: undefined,
    });
    moduleBuilder.overrideProvider(USER_ACCESS_TOKEN_VERIFIER).useValue({
      verify: jest.fn(async (token: string) => {
        const userId = new Map([
          ['active.payload.signature', 'active-user'],
          ['disabled.payload.signature', 'disabled-user'],
        ]).get(token);
        if (!userId) throw new Error('invalid token');
        return verifiedUserAccessToken(userId, 'test-token');
      }),
    });
    moduleBuilder.overrideProvider(USER_ACCOUNT_REPOSITORY).useValue({
      findUserAccountStatus: jest.fn(async (userId: string) =>
        userId === 'active-user' ? 'active' : 'disabled',
      ),
    });
    moduleBuilder
      .overrideProvider(USER_ACCESS_TOKEN_REVOCATION_RECORD)
      .useValue(NO_USER_ACCESS_TOKEN_REVOCATIONS);
    const moduleRef = await moduleBuilder.compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method)
          ? route.method
          : [route.method];
        for (const method of methods) {
          registeredRoutes.push({ method, url: route.url });
        }
      });
    registerBodySizeGuard(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health unversioned so probes do not depend on the API version', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('serves readiness separately and marks unconfigured dependencies down', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      dependencies: {
        'runtime-postgres': 'down',
        'control-plane-write-postgres': 'down',
        'control-plane-read-postgres': 'down',
        redis: 'down',
      },
    });
  });

  it.each(docsRoutes)(
    'denies unauthenticated, invalid, expired, and disabled-account requests to %s',
    async (url) => {
      for (const authorization of [
        undefined,
        'Bearer malformed',
        'Bearer invalid.payload.signature',
        'Bearer expired.payload.signature',
        'Bearer disabled.payload.signature',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: authorization ? { authorization } : {},
        });

        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.payload).not.toContain('active.payload.signature');
      }
    },
  );

  it('does not accept access tokens from cookies or query parameters', async () => {
    const cookie = await app.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { cookie: 'access_token=active.payload.signature' },
    });
    const query = await app.inject({
      method: 'GET',
      url: '/openapi.json?access_token=active.payload.signature',
    });

    expect(cookie.statusCode).toBe(401);
    expect(query.statusCode).toBe(401);
  });

  it('serves /docs HTML to an active account with a Bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: 'Bearer active.payload.signature' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toContain(
      `data-url="/openapi/v${latestPublicApiMajor().major}.json"`,
    );
  });

  it.each([
    '/openapi.json',
    ...supportedPublicApiMajors().map(({ major }) => `/openapi/v${major}.json`),
  ])('serves %s to an active account with a Bearer token', async (url) => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer active.payload.signature' },
    });

    const expectedVersion =
      url === '/openapi.json'
        ? latestPublicApiMajor().contractVersion
        : supportedPublicApiMajors().find(({ major }) =>
            url.endsWith(`/v${major}.json`),
          )?.contractVersion;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      info: { version: expectedVersion },
    });
  });

  it('does not serve an unsupported version to an active account', async () => {
    const unsupportedMajor =
      Math.max(...supportedPublicApiMajors().map(({ major }) => major)) + 1;
    const response = await app.inject({
      method: 'GET',
      url: `/openapi/v${unsupportedMajor}.json`,
      headers: { authorization: 'Bearer active.payload.signature' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not double the version prefix onto any declared public path', () => {
    // Both registries: a doubled prefix would register a route nothing
    // documents, and the route-coverage check below would only see the shape.
    for (const { path } of [
      ...Object.values(OPERATION_CATALOG),
      ...Object.values(PUBLIC_ROUTES),
    ]) {
      expect(path).toMatch(/^\/v[1-9][0-9]*\//);
      expect(path).not.toMatch(/^\/v[1-9][0-9]*\/v[1-9][0-9]*\//);
    }
  });

  it('documents every registered Public API Route by method and path shape', () => {
    const missing = missingPublicRoutes(
      registeredRoutes,
      buildOpenApiDocument(publicApiMajorV1()),
    );

    expect(missing).toEqual([]);
  });

  it('fails when the method is missing even though the path remains', () => {
    const openApiDocument = JSON.parse(
      JSON.stringify(buildOpenApiDocument(publicApiMajorV1())),
    ) as { paths: Record<string, unknown> };
    const speakingPath = openApiDocument.paths[
      '/v1/ielts/speaking/questions'
    ] as { get?: unknown };
    delete speakingPath.get;

    expect(missingPublicRoutes(registeredRoutes, openApiDocument)).toContain(
      'GET /v1/ielts/speaking/questions',
    );
  });

  it('renders an AppError through the globally bound filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        retryable: true,
      },
    });
    expect(requestIdOf(response)).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('reports an unknown route as 404 NOT_FOUND rather than 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', retryable: false },
    });
    // Nest's own message would echo the route back to the caller.
    expect(response.payload).not.toContain('/nope');
  });

  it.each([
    '/v1/ielts/writing/task1/questions',
    '/v1/ielts/writing/task2/questions',
  ])('does not expose removed question-generation route %s', async (url) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('stamps every response with a contract-shaped request id', async () => {
    const first = await app.inject({ method: 'GET', url: '/boom' });
    const second = await app.inject({ method: 'GET', url: '/boom' });

    const firstId = requestIdOf(first);
    const secondId = requestIdOf(second);

    expect(firstId).not.toBe(secondId);
    expect(firstId < secondId).toBe(true);
  });
});
