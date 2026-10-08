import type { FastifyRequest } from 'fastify';

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

function rawCookieHeader(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  return Array.isArray(header) ? header.join(';') : header;
}

function hasDuplicateCookie(
  request: FastifyRequest,
  cookieName: string,
): boolean {
  // Fastify's parsed cookie map collapses duplicate names. This metadata-only
  // scan is therefore limited to counting the named cookie; credential value
  // extraction still comes exclusively from request.cookies below.
  const header = rawCookieHeader(request);
  if (header === undefined) {
    return false;
  }

  let count = 0;
  for (const part of header.split(';')) {
    const name = part.trim().split('=', 1)[0]?.trim();
    if (name === cookieName) {
      count += 1;
    }
  }
  return count > 1;
}

function hasQueryValue(source: unknown): boolean {
  return (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    Object.keys(source).length > 0
  );
}

function hasUnknownCookie(request: FastifyRequest): boolean {
  return Object.keys(request.cookies ?? {}).some(
    (name) => name !== REFRESH_COOKIE_NAME,
  );
}

export function refreshCookieFrom(request: FastifyRequest): string | undefined {
  if (hasDuplicateCookie(request, REFRESH_COOKIE_NAME)) {
    return undefined;
  }
  const value = request.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function hasAlternateRefreshSource(request: FastifyRequest): boolean {
  return (
    request.headers.authorization !== undefined ||
    hasQueryValue(request.query) ||
    hasUnknownCookie(request) ||
    hasDuplicateCookie(request, REFRESH_COOKIE_NAME)
  );
}
