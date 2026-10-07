import type { FastifyInstance } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { pathnameOf } from '@/common/http/request-path';

const NO_STORE_PATHS: ReadonlySet<string> = new Set([
  OPERATION_CATALOG['speaking.grading'].path,
  OPERATION_CATALOG['speaking.grading-json'].path,
]);

export function registerSpeakingGradingHeaders(
  instance: FastifyInstance,
): void {
  instance.addHook('onSend', (request, reply, payload, done) => {
    if (NO_STORE_PATHS.has(pathnameOf(request.url))) {
      reply.header('Cache-Control', 'no-store');
    }
    done(null, payload);
  });
}
