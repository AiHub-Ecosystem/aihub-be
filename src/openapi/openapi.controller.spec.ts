import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import {
  type PublicApiMajorDef,
  latestPublicApiMajor,
} from '@/catalog/public-api-majors';
import { registerRequestHooks } from '@/register-request-hooks';
import { buildOpenApiDocument } from './build-openapi-document';
import { docsPage, versionedDocumentMajor } from './openapi.controller';
import { OpenApiModule } from './openapi.module';

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
      info: { version: latestPublicApiMajor().contractVersion },
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
      JSON.stringify(buildOpenApiDocument()),
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

  it.each(['/openapi/v2.json', '/openapi/v1', '/openapi/latest.json'])(
    'answers %s, which names no supported major, with 404',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);
    },
  );
});

describe('versioned contracts with two supported majors and one retired', () => {
  const sunset = {
    successor: 2,
    deprecationAt: '2027-01-01T00:00:00Z',
    sunsetAt: '2028-01-01T00:00:00Z',
  };
  const majors: readonly PublicApiMajorDef[] = [
    {
      major: 1,
      contractVersion: '1.4.0',
      status: 'retired',
      releasedAt: '2026-10-27',
      sunset,
    },
    {
      major: 2,
      contractVersion: '2.3.0',
      status: 'supported',
      releasedAt: '2027-01-01',
      sunset: { ...sunset, successor: 3, sunsetAt: '2029-01-01T00:00:00Z' },
    },
    {
      major: 3,
      contractVersion: '3.0.0',
      status: 'supported',
      releasedAt: '2028-01-01',
    },
  ];

  it('serves each supported major and no retired one', () => {
    expect(versionedDocumentMajor('v2.json', majors)?.contractVersion).toBe(
      '2.3.0',
    );
    expect(versionedDocumentMajor('v3.json', majors)?.contractVersion).toBe(
      '3.0.0',
    );
    expect(versionedDocumentMajor('v1.json', majors)).toBeUndefined();
    expect(versionedDocumentMajor('v4.json', majors)).toBeUndefined();
  });

  it('builds each document from its own major only', () => {
    const document = buildOpenApiDocument({
      major: 2,
      contractVersion: '2.3.0',
      status: 'supported',
      releasedAt: '2027-01-01',
    }) as { info: { version: string }; paths: Record<string, unknown> };

    expect(document.info.version).toBe('2.3.0');
    expect(Object.keys(document.paths)).toEqual([]);
  });

  it('lists only supported majors in the /docs selector, newest marked current', () => {
    const page = docsPage('v2', majors);

    expect(page).toContain('<option value="v3">v3 (current)</option>');
    expect(page).toContain('<option value="v2" selected>v2</option>');
    expect(page).not.toContain('value="v1"');
    expect(page).toContain('data-url="/openapi/v2.json"');
  });
});
