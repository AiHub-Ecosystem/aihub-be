import type { FastifyRequest } from 'fastify';

import {
  hasDuplicateCookie,
  offersCredentialOutsideTransport,
} from './credential-transport';

export const REFRESH_COOKIE_NAME = '__Host-aihub_refresh';
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: REFRESH_COOKIE_MAX_AGE_SECONDS,
  path: '/',
  sameSite: 'strict',
  secure: true,
} as const;

export const REFRESH_COOKIE_CLEAR_OPTIONS = {
  ...REFRESH_COOKIE_OPTIONS,
  expires: new Date(0),
  maxAge: 0,
} as const;

export function refreshCookieFrom(request: FastifyRequest): string | undefined {
  if (hasDuplicateCookie(request, REFRESH_COOKIE_NAME)) {
    return undefined;
  }
  const value = request.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function hasAlternateRefreshSource(request: FastifyRequest): boolean {
  return offersCredentialOutsideTransport(request, REFRESH_COOKIE_NAME);
}
