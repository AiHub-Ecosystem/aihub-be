import type { FastifyInstance } from 'fastify';

export function registerSecurityHeaders(instance: FastifyInstance): void {
  instance.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    done(null, payload);
  });
}
