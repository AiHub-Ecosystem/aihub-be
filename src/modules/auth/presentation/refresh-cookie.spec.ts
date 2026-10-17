import type { FastifyRequest } from 'fastify';

import {
  REFRESH_COOKIE_NAME,
  hasAlternateRefreshSource,
  refreshCookieFrom,
} from './refresh-cookie';

/**
 * Fastify's parsed `cookies` keeps one value per name; the raw header is what
 * shows a second cookie of the same name planted by a sibling subdomain.
 */
function request(input: {
  readonly cookieHeader?: string;
  readonly cookies?: Record<string, string>;
  readonly authorization?: string;
  readonly query?: Record<string, string>;
}): FastifyRequest {
  return {
    headers: {
      ...(input.cookieHeader === undefined
        ? {}
        : { cookie: input.cookieHeader }),
      ...(input.authorization === undefined
        ? {}
        : { authorization: input.authorization }),
    },
    cookies: input.cookies ?? {},
    query: input.query ?? {},
  } as unknown as FastifyRequest;
}

const single = request({
  cookieHeader: `${REFRESH_COOKIE_NAME}=token-a`,
  cookies: { [REFRESH_COOKIE_NAME]: 'token-a' },
});

const duplicated = request({
  cookieHeader: `${REFRESH_COOKIE_NAME}=token-a; ${REFRESH_COOKIE_NAME}=planted`,
  cookies: { [REFRESH_COOKIE_NAME]: 'token-a' },
});

describe('refreshCookieFrom', () => {
  it('reads the one refresh cookie', () => {
    expect(refreshCookieFrom(single)).toBe('token-a');
  });

  it('reads nothing when the header carries the refresh cookie twice', () => {
    expect(refreshCookieFrom(duplicated)).toBeUndefined();
  });

  it('reads nothing from an empty refresh cookie', () => {
    expect(
      refreshCookieFrom(
        request({
          cookieHeader: `${REFRESH_COOKIE_NAME}=`,
          cookies: { [REFRESH_COOKIE_NAME]: '' },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('hasAlternateRefreshSource', () => {
  it('is false for a request carrying only the refresh cookie', () => {
    expect(hasAlternateRefreshSource(single)).toBe(false);
  });

  it.each([
    ['a duplicated refresh cookie', duplicated],
    [
      'another cookie',
      request({
        cookieHeader: `${REFRESH_COOKIE_NAME}=token-a; other=1`,
        cookies: { [REFRESH_COOKIE_NAME]: 'token-a', other: '1' },
      }),
    ],
    ['an Authorization header', request({ authorization: 'Bearer token-a' })],
    ['a query value', request({ query: { refresh_token: 'token-a' } })],
  ])('is true for %s', (_label, candidate) => {
    expect(hasAlternateRefreshSource(candidate)).toBe(true);
  });
});
