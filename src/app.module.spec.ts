import { Controller, Get } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from './app.module';
import { OPERATION_CATALOG } from './catalog/operation-catalog';
import { PUBLIC_ROUTES } from './catalog/public-routes';
import { AppError } from './common/errors/app-error';
import { registerBodySizeGuard } from './common/http/body-size.hook';
import { generateRequestId } from './common/request-context/request-id';
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

  beforeAll(async () => {
    const moduleBuilder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoomController],
    });
    moduleBuilder.overrideProvider(RUNTIME_CONNECTION_CONFIGURATION).useValue({
      databaseUrl: undefined,
      controlPlaneDatabaseUrl: undefined,
      controlPlaneReadDatabaseUrl: undefined,
      redisUrl: undefined,
      sandboxAssertionPrivateKey: undefined,
      sandboxAssertionKeyId: undefined,
    });
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

  it('serves the docs page and raw spec unauthenticated through the real app wiring', async () => {
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });
    const docs = await app.inject({ method: 'GET', url: '/docs' });

    expect(spec.statusCode).toBe(200);
    expect(docs.statusCode).toBe(200);
  });

  it('does not double the version prefix onto any declared public path', () => {
    // Both registries: a doubled prefix would register a route nothing
    // documents, and the route-coverage check below would only see the shape.
    for (const { path } of [
      ...Object.values(OPERATION_CATALOG),
      ...Object.values(PUBLIC_ROUTES),
    ]) {
      expect(path).toMatch(/^\/v1\//);
      expect(path).not.toMatch(/^\/v1\/v1\//);
    }
  });

  it('documents every registered Public API Route by method and path shape', () => {
    const missing = missingPublicRoutes(
      registeredRoutes,
      buildOpenApiDocument('test'),
    );

    expect(missing).toEqual([]);
  });

  it('fails when the method is missing even though the path remains', () => {
    const openApiDocument = JSON.parse(
      JSON.stringify(buildOpenApiDocument('test')),
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
    expect(response.json()).toEqual({
      error: {
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
        retryable: true,
      },
    });
  });

  it('reports an unknown route as 404 NOT_FOUND rather than 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
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
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('stamps every response with a contract-shaped request id', async () => {
    const first = await app.inject({ method: 'GET', url: '/boom' });
    const second = await app.inject({ method: 'GET', url: '/boom' });

    const firstId = first.json().error.request_id;
    const secondId = second.json().error.request_id;

    expect(firstId).not.toBe(secondId);
    expect(firstId < secondId).toBe(true);
  });
});
