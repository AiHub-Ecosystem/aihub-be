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

const ALTERNATE_TOKEN_NAMES = new Set([
  'access_token',
  'accesstoken',
  'authorization',
  'refresh',
  'refresh-token',
  'refresh_token',
  'refreshtoken',
  'token',
]);

function rawCookieHeader(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  return Array.isArray(header) ? header.join(';') : header;
}

function hasDuplicateCookie(
  request: FastifyRequest,
  cookieName: string,
): boolean {
  const header = rawCookieHeader(request);
  if (header === undefined) {
    return false;
  }

  let count = 0;
  for (const part of header.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (name === cookieName) {
      count += 1;
    }
  }
  return count > 1;
}

function hasTokenName(source: unknown): boolean {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return false;
  }
  return Object.keys(source).some((key) =>
    ALTERNATE_TOKEN_NAMES.has(key.toLowerCase()),
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
    hasTokenName(request.query) ||
    hasTokenName(request.cookies) ||
    hasDuplicateCookie(request, REFRESH_COOKIE_NAME)
  );
}
