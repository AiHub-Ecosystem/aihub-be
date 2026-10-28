import Fastify, { type FastifyInstance } from 'fastify';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';
import { registerSecurityHeaders } from './security-headers.hook';

const CATALOG_ROUTES = [
  ...(Object.values(PUBLIC_ROUTES) as PublicRouteDef[]),
  ...(Object.values(OPERATION_CATALOG) as OperationDef[]),
];
const ERROR_ROUTE_PATH = PUBLIC_ROUTES['sandbox.demo-key.validate'].path;
const DEPRECATED_ROUTE = {
  method: 'GET',
  path: '/v1/deprecated',
  sunset: {
    deprecationAt: '2023-01-01T00:00:00Z',
    sunsetAt: '2027-06-30T00:00:00Z',
    successorRouteId: 'organizations.create',
    rationale: 'Use the current organization route.',
  },
} as const;

function requestPath(path: string): string {
  return path.replace(/:[^/]+/g, 'catalog-id');
}

describe('registerSecurityHeaders', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerSecurityHeaders(app, [DEPRECATED_ROUTE]);
    app.get('/health', async () => ({ status: 'ok' }));
    app.get(DEPRECATED_ROUTE.path, async () => ({ ok: true }));
    app.get('/custom-csp', async (_request, reply) => {
      reply.header('Content-Security-Policy', "default-src 'self'");
      return { ok: true };
    });
    app.get('/bad', async (_request, reply) => {
      reply.code(400);
      return { error: 'bad' };
    });
    for (const route of CATALOG_ROUTES) {
      app.route({
        method: route.method,
        url: route.path,
        handler: async (_request, reply) => {
          if (route.path === ERROR_ROUTE_PATH) reply.code(403);
          return { ok: true };
        },
      });
    }
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets the baseline header set on a 200 JSON response', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('emits separate RFC 9745 deprecation and HTTP Sunset dates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: DEPRECATED_ROUTE.path,
    });

    expect(response.headers.deprecation).toBe('@1672531200');
    expect(response.headers.sunset).toBe('Wed, 30 Jun 2027 00:00:00 GMT');
    expect(response.headers.link).toBe(
      '</docs#organizations.create>; rel="successor-version"; title="organizations.create"',
    );
  });

  it('omits deprecation headers for a route without a sunset descriptor', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers.deprecation).toBeUndefined();
    expect(response.headers.sunset).toBeUndefined();
    expect(response.headers.link).toBeUndefined();
  });

  it('sets the baseline header set on an unmatched 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('sets the baseline header set on a 4xx error envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/bad' });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('applies Cache-Control from every route catalog entry', async () => {
    for (const route of CATALOG_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: requestPath(route.path),
      });

      expect(response.headers['cache-control']).toBe(route.cacheControl?.value);
    }
  });

  it('keeps no-store on a catalogued error response and implicit HEAD route', async () => {
    const error = await app.inject({
      method: 'POST',
      url: ERROR_ROUTE_PATH,
    });
    const head = await app.inject({
      method: 'HEAD',
      url: PUBLIC_ROUTES['speaking.questions'].path,
    });

    expect(error.statusCode).toBe(403);
    expect(error.headers['cache-control']).toBe('no-store');
    expect(head.headers['cache-control']).toBe('no-store');
  });

  it('lets a route-specific CSP override the global one without doubling', async () => {
    const response = await app.inject({ method: 'GET', url: '/custom-csp' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'self'",
    );
  });
});
