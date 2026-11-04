import type { FastifyRequest } from 'fastify';

export function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}
