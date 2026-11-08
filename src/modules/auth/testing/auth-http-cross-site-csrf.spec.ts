import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Value } from '@sinclair/typebox/value';

import { LoginResponseSchema } from '@/contracts/auth/local-auth';
import {
  preLoginCsrfToken,
  sessionCsrfToken,
} from '@/modules/auth/shared/presentation/cross-site-csrf';
import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  type LocalAuthTestContext,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';
import { REFRESH_COOKIE_NAME } from '@/modules/auth/web-sessions/public/refresh-cookie';

type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

/**
 * Cross-site BFF forwarding (ADR-0157): the same three refresh-cookie routes
 * the browser calls same-site, forwarded by the Customer Web BFF with its
 * client secret, the end user's address, and the rotating CSRF token.
 */
describe('local auth HTTP boundary - cross-site BFF forwarding', () => {
  const CLIENT_SECRET = 'test-bff-client-secret';
  const END_USER_IP = '203.0.113.7';
  let c: LocalAuthTestContext;
  beforeAll(async () => {
    c = await createLocalAuthTestContext(
      undefined,
      undefined,
      undefined,
      CLIENT_SECRET,
    );
  });
  afterAll(async () => {
    await c.app.close();
  });
  beforeEach(() => {
    c.reset();
    seedAccount(c.state, {
      userId: USER_ID,
      email: EMAIL,
      username: 'person_01',
      passwordHash: '$argon2id$fake',
    });
  });

  function bffHeaders(csrf?: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-aihub-client-secret': CLIENT_SECRET,
      'x-aihub-end-user-ip': END_USER_IP,
      ...(csrf === undefined ? {} : { 'x-aihub-csrf-token': csrf }),
    };
  }

  /** The cookie value the response's Set-Cookie carries. */
  function refreshValueOf(response: InjectResponse): string {
    const setCookie = response.headers['set-cookie'];
    if (setCookie === undefined) {
      throw new Error('the response set no refresh cookie');
    }
    const cookie: unknown = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof cookie !== 'string') {
      throw new Error('the response refresh cookie was not a string');
    }
    return cookie.split(';')[0]?.split('=')[1] ?? '';
  }

  async function loginForwarded(csrf?: string): Promise<InjectResponse> {
    return c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: bffHeaders(csrf),
      payload: { email: EMAIL, password: 'correct password' },
    });
  }

  function refreshForwarded(
    refreshValue: string,
    csrf: string,
  ): Promise<InjectResponse> {
    return c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        ...bffHeaders(csrf),
        cookie: `${REFRESH_COOKIE_NAME}=${refreshValue}`,
      },
      payload: {},
    });
  }

  it('rejects a forwarded login without or with a wrong CSRF token', async () => {
    const missing = await loginForwarded();
    expect(missing.statusCode).toBe(401);
    expect(missing.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(missing.headers['set-cookie']).toBeUndefined();
    expect(c.state.refreshTokens.size).toBe(0);

    const wrong = await loginForwarded(preLoginCsrfToken('another-secret'));
    expect(wrong.statusCode).toBe(401);
    expect(c.state.refreshTokens.size).toBe(0);
  });

  it('refuses a forwarded login that omits the end-user address', async () => {
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        'x-aihub-client-secret': CLIENT_SECRET,
        'x-aihub-csrf-token': preLoginCsrfToken(CLIENT_SECRET),
      },
      payload: { email: EMAIL, password: 'correct password' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
    });
  });

  it('logs a forwarded login in with the session-bound CSRF token', async () => {
    const login = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toContain('SameSite=Strict');

    const body = Value.Parse(LoginResponseSchema, login.json<unknown>());
    const refreshValue = refreshValueOf(login);
    // The token derives from the credential the cookie carries, so nothing
    // extra is stored and rotation rotates it for free.
    expect(body.data.csrf_token).toBe(
      sessionCsrfToken(CLIENT_SECRET, refreshValue),
    );
    expect(c.state.refreshTokens.size).toBe(1);
  });

  it('rate-limits a forwarded login failure against the end-user address', async () => {
    c.hasher.result = false;
    const failed = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    expect(failed.statusCode).toBe(401);
    // The BFF's shared peer address is never a rate-limit key (ADR-0081).
    expect(
      c.limiter.calls.some(
        (call) => call.scope === 'login_ip' && call.key === END_USER_IP,
      ),
    ).toBe(true);
  });

  it('keeps the MFA_REQUIRED answer CSRF-gated and without a CSRF token', async () => {
    c.mfa.loginResult = { kind: 'required' };
    const gated = await loginForwarded();
    expect(gated.statusCode).toBe(401);

    const required = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    expect(required.statusCode).toBe(202);
    expect(required.json<unknown>()).toMatchObject({
      data: { status: 'MFA_REQUIRED' },
    });
    expect(required.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a forwarded refresh without the CSRF token and keeps the cookie', async () => {
    const login = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    const loginValue = refreshValueOf(login);

    const refused = await refreshForwarded(
      loginValue,
      sessionCsrfToken(CLIENT_SECRET, 'not-the-presented-credential'),
    );
    const withoutHeader = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        ...bffHeaders(),
        cookie: `${REFRESH_COOKIE_NAME}=${loginValue}`,
      },
      payload: {},
    });

    for (const refusedCase of [refused, withoutHeader]) {
      expect(refusedCase.statusCode).toBe(401);
      expect(refusedCase.json<unknown>()).toMatchObject({
        error: { code: 'AUTH_REFRESH_TOKEN_INVALID' },
      });
      // A CSRF probe must not log the victim out.
      expect(refusedCase.headers['set-cookie']).toBeUndefined();
    }
    expect(c.state.refreshTokens.size).toBe(1);

    const stillValid = await refreshForwarded(
      loginValue,
      sessionCsrfToken(CLIENT_SECRET, loginValue),
    );
    expect(stillValid.statusCode).toBe(200);
  });

  it('rotates the CSRF token with the credential on a forwarded refresh', async () => {
    const login = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    const loginValue = refreshValueOf(login);
    const loginCsrf = sessionCsrfToken(CLIENT_SECRET, loginValue);

    const rotated = await refreshForwarded(loginValue, loginCsrf);
    expect(rotated.statusCode).toBe(200);
    const rotatedValue = refreshValueOf(rotated);
    expect(rotatedValue).not.toBe(loginValue);
    const rotatedBody = Value.Parse(
      LoginResponseSchema,
      rotated.json<unknown>(),
    );
    // The new token binds to the successor credential; the old one is dead.
    expect(rotatedBody.data.csrf_token).toBe(
      sessionCsrfToken(CLIENT_SECRET, rotatedValue),
    );
    expect(rotatedBody.data.csrf_token).not.toBe(loginCsrf);

    const staleToken = await refreshForwarded(rotatedValue, loginCsrf);
    expect(staleToken.statusCode).toBe(401);
  });

  it('revokes on a forwarded logout only with the valid CSRF token', async () => {
    const login = await loginForwarded(preLoginCsrfToken(CLIENT_SECRET));
    const loginValue = refreshValueOf(login);

    const probe = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        ...bffHeaders(),
        cookie: `${REFRESH_COOKIE_NAME}=${loginValue}`,
      },
      payload: {},
    });
    expect(probe.statusCode).toBe(204);
    const survived = await refreshForwarded(
      loginValue,
      sessionCsrfToken(CLIENT_SECRET, loginValue),
    );
    expect(survived.statusCode).toBe(200);

    const revokedValue = refreshValueOf(survived);
    const logout = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: {
        ...bffHeaders(sessionCsrfToken(CLIENT_SECRET, revokedValue)),
        cookie: `${REFRESH_COOKIE_NAME}=${revokedValue}`,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await refreshForwarded(
      revokedValue,
      sessionCsrfToken(CLIENT_SECRET, revokedValue),
    );
    expect(afterLogout.statusCode).toBe(401);
  });

  it('keeps the same-site flow free of the CSRF contract', async () => {
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    expect(login.statusCode).toBe(200);
    const body = Value.Parse(LoginResponseSchema, login.json<unknown>());
    expect(body.data.csrf_token).toBeUndefined();

    // No client secret, no CSRF header: today's refresh.
    const refreshed = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${refreshValueOf(login)}` },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
  });
});
