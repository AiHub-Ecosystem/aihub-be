import type { FastifyInstance } from 'fastify';

export function registerRequestIdResponseHeader(
  instance: FastifyInstance,
): void {
  instance.addHook('onSend', (request, reply, payload, done) => {
    reply.header('X-Request-Id', String(request.id));
    done(null, payload);
  });
}
