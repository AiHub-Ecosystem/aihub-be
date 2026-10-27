import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { registerRequestHooks } from '@/register-request-hooks';
import { buildOpenApiDocument } from './build-openapi-document';
import { OpenApiModule } from './openapi.module';
import { PUBLIC_API_CONTRACT_VERSION } from './public-api-contract-version';

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
    const versionedResponse = await app.inject({
      method: 'GET',
      url: '/openapi/v1.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      info: { version: PUBLIC_API_CONTRACT_VERSION },
    });
    expect(versionedResponse.statusCode).toBe(200);
    expect(versionedResponse.json()).toEqual(response.json());
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    // The public contract version is independent from the package version.
    // Round-tripped through JSON on the expected side too: TypeBox schemas
    // carry internal Symbol-keyed metadata that a real HTTP response body
    // (this one included) can never actually transmit.
    const expected: unknown = JSON.parse(
      JSON.stringify(buildOpenApiDocument(PUBLIC_API_CONTRACT_VERSION)),
    );
    expect(response.json()).toEqual(expected);
  });

  it('serves /docs as HTML that points Scalar at the same-origin spec endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });
    const versionedResponse = await app.inject({
      method: 'GET',
      url: '/docs?version=v1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'sha384-JezfTaoGe2t8F2YRYUQosjM0S21blpE8j3yOUgTEiTKCyLWx9K4lfwjKPd8Dp7WY'; style-src 'unsafe-inline'; connect-src 'self'; font-src https://fonts.scalar.com",
    );
    expect(response.payload).toContain('name="version"');
    expect(response.payload).toContain('value="v1" selected');
    expect(response.payload).toContain('data-url="/openapi/v1.json"');
    expect(versionedResponse.statusCode).toBe(200);
    expect(versionedResponse.payload).toContain('data-url="/openapi/v1.json"');
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
