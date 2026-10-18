import type { FastifyInstance } from 'fastify';

const BASELINE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function registerSecurityHeaders(instance: FastifyInstance): void {
  instance.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', BASELINE_CONTENT_SECURITY_POLICY);
    }
    if (!reply.hasHeader('x-frame-options')) {
      reply.header('X-Frame-Options', 'DENY');
    }
    done(null, payload);
  });
}

export { BASELINE_CONTENT_SECURITY_POLICY };
