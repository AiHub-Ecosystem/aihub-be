import type { FastifyRequest } from 'fastify';

import {
  hasDuplicateCookie,
  offersCredentialOutsideTransport,
} from './credential-transport';

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

describe('offersCredentialOutsideTransport', () => {
  it('accepts a request with nothing but the body transport', () => {
    expect(offersCredentialOutsideTransport(request({}))).toBe(false);
  });

  it.each([
    ['an Authorization header', request({ authorization: 'Bearer x' })],
    ['a query value', request({ query: { token: 'x' } })],
    ['any cookie', request({ cookies: { analytics: '1' } })],
  ])('refuses %s on a route that reads no cookie', (_label, candidate) => {
    expect(offersCredentialOutsideTransport(candidate)).toBe(true);
  });

  it('lets a cookie route see its own cookie and nothing else', () => {
    const own = request({
      cookieHeader: 'sid=a',
      cookies: { sid: 'a' },
    });
    const other = request({
      cookieHeader: 'sid=a; other=1',
      cookies: { sid: 'a', other: '1' },
    });
    const twice = request({
      cookieHeader: 'sid=a; sid=planted',
      cookies: { sid: 'a' },
    });

    expect(offersCredentialOutsideTransport(own, 'sid')).toBe(false);
    expect(offersCredentialOutsideTransport(other, 'sid')).toBe(true);
    expect(offersCredentialOutsideTransport(twice, 'sid')).toBe(true);
    expect(offersCredentialOutsideTransport(own)).toBe(true);
  });
});

describe('hasDuplicateCookie', () => {
  it('counts the named cookie in the raw header', () => {
    expect(hasDuplicateCookie(request({ cookieHeader: 'a=1; a=2' }), 'a')).toBe(
      true,
    );
    expect(hasDuplicateCookie(request({ cookieHeader: 'a=1; b=2' }), 'a')).toBe(
      false,
    );
    expect(hasDuplicateCookie(request({}), 'a')).toBe(false);
  });
});
