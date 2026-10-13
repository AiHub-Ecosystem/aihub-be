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
