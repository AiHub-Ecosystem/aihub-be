import type { FastifyReply, FastifyRequest } from 'fastify';

import type { LoginResponse } from '@/contracts/auth/local-auth';
import type { IssuedSession } from '@/modules/auth/local-credentials/public/session';
import {
  REFRESH_COOKIE_CLEAR_OPTIONS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTIONS,
} from '@/modules/auth/web-sessions/public/refresh-cookie';

import { accessTokenEnvelope } from './access-token-envelope';

/** Sets the refresh cookie and returns the envelope every session-issuing route shares. */
export function sessionEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  session: IssuedSession,
): LoginResponse {
  reply.setCookie(
    REFRESH_COOKIE_NAME,
    session.refreshToken,
    REFRESH_COOKIE_OPTIONS,
  );
  return accessTokenEnvelope(
    session.accessToken,
    session.expiresIn,
    String(request.id),
  );
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.setCookie(REFRESH_COOKIE_NAME, '', REFRESH_COOKIE_CLEAR_OPTIONS);
}
