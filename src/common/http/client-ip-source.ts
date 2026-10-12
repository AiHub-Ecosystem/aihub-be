import type { FastifyRequest } from 'fastify';

export type ClientIpSource =
  | 'nginx'
  | 'customer_web_bff'
  | 'end_user_forwarded'
  | 'direct_peer';

declare module 'fastify' {
  interface FastifyRequest {
    aihubClientIpSource?: ClientIpSource;
  }
}

export function clientIpSource(request: FastifyRequest): ClientIpSource {
  if (request.aihubClientIpSource !== undefined) {
    return request.aihubClientIpSource;
  }

  return request.ips !== undefined && request.ips.length > 1
    ? 'nginx'
    : 'direct_peer';
}
