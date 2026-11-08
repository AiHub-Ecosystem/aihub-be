import type { FastifyReply, FastifyRequest } from 'fastify';

import type { LoginResponse } from '@/contracts/auth/local-auth';
import type { IssuedSession } from '@/modules/auth/local-credentials/public/session';
import {
  REFRESH_COOKIE_CLEAR_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
} from '@/modules/auth/web-sessions/public/refresh-cookie';

import { accessTokenEnvelope } from './access-token-envelope';

/**
 * Sets the refresh cookie and returns the envelope every session-issuing route
 * shares. `csrfToken` is defined only on the cross-site BFF-forwarded path
 * (ADR-0157); same-site responses stay byte-identical without it.
 */
export function sessionEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  session: IssuedSession,
  csrfToken?: string,
): LoginResponse {
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    session.refreshToken,
    REFRESH_COOKIE_OPTIONS,
  );
  const envelope = accessTokenEnvelope(
    session.accessToken,
    session.expiresIn,
    String(request.id),
  );
  if (csrfToken !== undefined) {
    envelope.data.csrf_token = csrfToken;
  }
  return envelope;
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.setCookie(REFRESH_COOKIE_NAME, '', REFRESH_COOKIE_CLEAR_OPTIONS);
}
