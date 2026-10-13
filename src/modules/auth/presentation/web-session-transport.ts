import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * The Customer Web BFF supplies the end user's address in its own header; the
 * client secret header and reader live in `@/common/http/client-secret-header`.
 */
export const WEB_SESSION_END_USER_IP_HEADER = 'X-AIHUB-End-User-IP';

/** Read the BFF-supplied end-user address after its client-secret guard passes. */
export function endUserIpFrom(request: FastifyRequest): string | undefined {
  const header = request.headers[WEB_SESSION_END_USER_IP_HEADER.toLowerCase()];
  return typeof header === 'string' && isIP(header) !== 0 ? header : undefined;
}

/**
 * The Web Session token has exactly one transport: the request body. This route
 * reads no cookie at all, unlike the refresh routes above, so ANY cookie — the
 * refresh cookie included — any `Authorization` header, and any query value all
 * mean the caller offered the credential somewhere AIHUB does not read it from.
 * Refusing keeps one unambiguous channel instead of a route whose credential
 * source depends on which transport happened to arrive.
 */
export function hasAlternateWebSessionSource(request: FastifyRequest): boolean {
  return (
    request.headers.authorization !== undefined ||
    (typeof request.query === 'object' &&
      request.query !== null &&
      Object.keys(request.query).length > 0) ||
    Object.keys(request.cookies ?? {}).length > 0
  );
}
