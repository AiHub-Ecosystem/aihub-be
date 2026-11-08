import type { FastifyRequest } from 'fastify';

import {
  AIHUB_CSRF_HEADER,
  csrfTokenFrom,
  csrfTokenMatches,
  preLoginCsrfToken,
  sessionCsrfToken,
} from './cross-site-csrf';

const SECRET = 'bff-client-secret';
const REFRESH = 'refresh-token-value';

function requestWithCsrf(header: unknown): FastifyRequest {
  return {
    headers:
      header === undefined ? {} : { [AIHUB_CSRF_HEADER.toLowerCase()]: header },
  } as unknown as FastifyRequest;
}

describe('cross-site CSRF tokens', () => {
  it('derives the pre-login token from the client secret alone', () => {
    expect(preLoginCsrfToken(SECRET)).toBe(preLoginCsrfToken(SECRET));
    expect(preLoginCsrfToken(SECRET)).not.toBe(preLoginCsrfToken('other'));
  });

  it('derives the session token from the client secret and the refresh credential', () => {
    expect(sessionCsrfToken(SECRET, REFRESH)).toBe(
      sessionCsrfToken(SECRET, REFRESH),
    );
    expect(sessionCsrfToken(SECRET, REFRESH)).not.toBe(
      sessionCsrfToken(SECRET, 'rotated-refresh-token-value'),
    );
    expect(sessionCsrfToken(SECRET, REFRESH)).not.toBe(
      sessionCsrfToken('other', REFRESH),
    );
    expect(sessionCsrfToken(SECRET, REFRESH)).not.toBe(
      preLoginCsrfToken(SECRET),
    );
  });

  it('derives 43-character base64url values that never contain the refresh credential', () => {
    const token = sessionCsrfToken(SECRET, REFRESH);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(REFRESH);
  });

  it('reads a string CSRF header and nothing else', () => {
    expect(csrfTokenFrom(requestWithCsrf('token-value'))).toBe('token-value');
    expect(csrfTokenFrom(requestWithCsrf(''))).toBeUndefined();
    expect(csrfTokenFrom(requestWithCsrf(42))).toBeUndefined();
    expect(csrfTokenFrom(requestWithCsrf(undefined))).toBeUndefined();
  });

  it('matches the presented token in constant time and refuses a missing one', () => {
    const expected = sessionCsrfToken(SECRET, REFRESH);
    expect(csrfTokenMatches(expected, expected)).toBe(true);
    expect(csrfTokenMatches(undefined, expected)).toBe(false);
    expect(csrfTokenMatches('short', expected)).toBe(false);
    expect(csrfTokenMatches(`${expected}x`, expected)).toBe(false);
  });
});
