import { createHmac } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { constantTimeEquals } from '@/common/security/constant-time-equals';

/**
 * The header a cross-site Customer Web BFF presents on the forwarded
 * login/refresh/logout calls of the refresh-cookie flow (ADR-0157). AIHUB
 * cannot lean on `SameSite=Strict` there: the request it receives is
 * server-to-server, so the browser's SameSite defense never applies at this
 * hop and the presented CSRF token replaces it.
 */
export const AIHUB_CSRF_HEADER = 'X-AIHUB-CSRF-Token';

const PRE_LOGIN_LABEL = 'aihub:cross-site-csrf:pre-login:v1';
const SESSION_LABEL = 'aihub:cross-site-csrf:session:v1';

function derive(clientSecret: string, message: string): string {
  return createHmac('sha256', clientSecret).update(message).digest('base64url');
}

/**
 * The CSRF token a BFF presents on a forwarded login. A login has no session
 * to bind a token to yet, so the token derives from the BFF client secret
 * instead: only code that already holds the secret can produce it.
 */
// ponytail: constant derived token; switch to a TTL-signed nonce from a
// dedicated endpoint if bounding its replay window ever matters.
export function preLoginCsrfToken(clientSecret: string): string {
  return derive(clientSecret, PRE_LOGIN_LABEL);
}

/**
 * The CSRF token bound to one refresh credential. Refresh rotates the
 * credential, so every rotation rotates this token with it; validation
 * recomputes it from the presented cookie value rather than storing anything.
 */
export function sessionCsrfToken(
  clientSecret: string,
  refreshToken: string,
): string {
  return derive(clientSecret, `${SESSION_LABEL}:${refreshToken}`);
}

/** Read the CSRF header after the BFF client-secret guard has passed. */
export function csrfTokenFrom(request: FastifyRequest): string | undefined {
  const header = request.headers[AIHUB_CSRF_HEADER.toLowerCase()];
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

/** Constant-time check so a wrong token answers like a missing one. */
export function csrfTokenMatches(
  presented: string | undefined,
  expected: string,
): boolean {
  return presented !== undefined && constantTimeEquals(presented, expected);
}
