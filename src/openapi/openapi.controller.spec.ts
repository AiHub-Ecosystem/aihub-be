import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { registerRequestHooks } from '@/register-request-hooks';
import { buildOpenApiDocument } from './build-openapi-document';
import { OpenApiModule } from './openapi.module';

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

describe('OpenApiController', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OpenApiModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    registerRequestHooks(app.getHttpAdapter().getInstance(), undefined);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /openapi.json unauthenticated, matching the running catalog', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBeUndefined();
    // Built from the same package.json this test process runs against, so
    // the version is whatever it is right now rather than a fixed literal.
    // Round-tripped through JSON on the expected side too: TypeBox schemas
    // carry internal Symbol-keyed metadata that a real HTTP response body
    // (this one included) can never actually transmit.
    const expected = JSON.parse(
      JSON.stringify(buildOpenApiDocument(packageVersion())),
    );
    expect(response.json()).toEqual(expected);
  });

  it('serves /docs as HTML that points Scalar at the same-origin spec endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY'; style-src 'unsafe-inline'; connect-src 'self'; font-src https://fonts.scalar.com",
    );
    expect(response.payload).toContain('data-url="/openapi.json"');
    expect(response.payload).toContain(
      '<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1" integrity="sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY" crossorigin="anonymous"></script>',
    );
  });

  it('sets baseline security headers on errors too', async () => {
    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });
});
