import Fastify, { type FastifyInstance } from 'fastify';

import { registerSecurityHeaders } from './security-headers.hook';

describe('registerSecurityHeaders', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerSecurityHeaders(app);
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/custom-csp', async (_request, reply) => {
      reply.header('Content-Security-Policy', "default-src 'self'");
      return { ok: true };
    });
    app.get('/bad', async (_request, reply) => {
      reply.code(400);
      return { error: 'bad' };
    });
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

  it('lets a route-specific CSP override the global one without doubling', async () => {
    const response = await app.inject({ method: 'GET', url: '/custom-csp' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'self'",
    );
  });
});
