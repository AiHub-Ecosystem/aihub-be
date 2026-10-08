import type { FastifyRequest } from 'fastify';

/**
 * The Customer Web BFF's static secret, in its own header so it never shares a
 * transport with the credential it authenticates.
 */
export const WEB_SESSION_CLIENT_SECRET_HEADER = 'X-AIHUB-Client-Secret';

/**
 * Reads the BFF client secret, or `undefined` when the request carried none.
 * Incoming header names arrive lowercased, so the lookup key is the published
 * name in that form rather than a second literal that could drift from it.
 */
export function clientSecretFrom(request: FastifyRequest): string | undefined {
  const header =
    request.headers[WEB_SESSION_CLIENT_SECRET_HEADER.toLowerCase()];
  return typeof header === 'string' ? header : undefined;
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
