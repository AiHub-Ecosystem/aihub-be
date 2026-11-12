import { Value } from '@sinclair/typebox/value';

import {
  LoginResponseSchema,
  MfaRequiredResponseSchema,
} from '@/contracts/auth/local-auth';
import {
  type InMemoryAccount,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  type LocalAuthTestContext,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';

describe('local auth HTTP boundary - sessions, login, and refresh', () => {
  let c: LocalAuthTestContext;
  beforeAll(async () => {
    c = await createLocalAuthTestContext();
  });
  afterAll(async () => {
    await c.app.close();
  });
  beforeEach(() => {
    c.reset();
  });

  function seedActiveAccount(): void {
    seedAccount(c.state, {
      userId: USER_ID,
      email: EMAIL,
      username: 'person_01',
      passwordHash: '$argon2id$fake',
    });
  }

  function account(): InMemoryAccount {
    const stored = c.state.accounts.get(USER_ID);
    if (stored === undefined) {
      throw new Error('the account was never seeded');
    }
    return stored;
  }

  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const setCookie = response.headers['set-cookie'];
    if (setCookie === undefined) {
      throw new Error('the response set no refresh cookie');
    }
    const cookie: unknown = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (typeof cookie !== 'string') {
      throw new Error('the response refresh cookie was not a string');
    }
    return cookie.split(';', 1)[0] ?? '';
  }

  it('logs in through the real HTTP stack with a narrow no-store response', async () => {
    seedActiveAccount();
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ' Person@Example.com ',
        password: '  exact password  ',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = Value.Parse(LoginResponseSchema, response.json<unknown>());
    expect(body.data).toEqual({
      access_token: 'ey.fake.access',
      token_type: 'Bearer',
      expires_in: 900,
    });
    expect(body.meta.request_id).toMatch(/^req_/);
    const setCookie = response.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie : [setCookie]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-aihub_refresh=.+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
        ),
      ]),
    );
  });

  it('returns MFA_REQUIRED without setting a refresh cookie or creating a session', async () => {
    seedActiveAccount();
    c.mfa.loginResult = { kind: 'required' };

    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct horse battery' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(
      Value.Parse(MfaRequiredResponseSchema, response.json<unknown>()).data,
    ).toEqual({ status: 'MFA_REQUIRED' });
    expect(c.state.refreshTokens.size).toBe(0);
  });

  it('keeps unknown and inactive login failures generic', async () => {
    c.hasher.result = false;

    const unknown = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com', password: 'wrong password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(unknown.payload).not.toContain('nobody@example.com');

    seedActiveAccount();
    const pending = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct horse battery' },
    });
    expect(pending.statusCode).toBe(401);
    expect(pending.payload).not.toContain('pending_verification');
  });

  it('rejects extra login fields at the boundary', async () => {
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        password: 'correct horse battery',
        remember_me: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rotates the refresh cookie and revokes a reused family', async () => {
    seedActiveAccount();
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

    const refresh = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: loginCookie,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(refresh.statusCode).toBe(200);
    expect(refresh.headers['cache-control']).toBe('no-store');
    const body = Value.Parse(LoginResponseSchema, refresh.json<unknown>());
    expect(body.data).toEqual({
      access_token: 'ey.fake.access',
      token_type: 'Bearer',
      expires_in: 900,
    });
    expect(body.meta.request_id).toMatch(/^req_/);
    const rotatedCookie = cookieOf(refresh);
    expect(rotatedCookie).not.toBe(loginCookie);

    const replay = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_REFRESH_TOKEN_INVALID' },
    });
    expect(String(replay.headers['set-cookie'])).toContain('Max-Age=0');

    const successorAfterReuse = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: rotatedCookie },
    });
    expect(successorAfterReuse.statusCode).toBe(401);
  });

  it('serializes concurrent refresh attempts so only one token rotates', async () => {
    seedActiveAccount();
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

    const [first, second] = await Promise.all([
      c.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: loginCookie },
      }),
      c.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: loginCookie },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual(
      [200, 401],
    );
  });

  it('rejects an expired or disabled refresh session over HTTP', async () => {
    seedActiveAccount();
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);
    const rawToken = loginCookie.slice(loginCookie.indexOf('=') + 1);
    const tokenHash = c.refreshTokenIssuer.hash(rawToken);
    const stored = c.state.refreshTokens.get(tokenHash);
    if (stored === undefined) {
      throw new Error('refresh session was not persisted');
    }
    c.state.refreshTokens.set(tokenHash, { ...stored, expiresAt: new Date(0) });

    const expired = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    expect(expired.statusCode).toBe(401);

    const activeLogin = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const activeCookie = cookieOf(activeLogin);
    account().status = 'disabled';

    const disabled = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: activeCookie },
    });
    expect(disabled.statusCode).toBe(401);
  });

  it('fails closed without a cookie when durable session persistence fails', async () => {
    seedActiveAccount();
    c.refreshSessions.failCreateRefreshSession = true;
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    c.refreshSessions.failCreateRefreshSession = false;

    expect(response.statusCode).toBe(500);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.payload).not.toContain('ey.fake.access');
    expect(c.state.refreshTokens.size).toBe(0);
  });

  it('logs out idempotently and only revokes the selected login family', async () => {
    seedActiveAccount();
    const first = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const second = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const firstCookie = cookieOf(first);
    const secondCookie = cookieOf(second);

    const logout = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: firstCookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.payload).toBe('');
    expect(logout.headers['cache-control']).toBe('no-store');
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

    const firstAfterLogout = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: firstCookie },
    });
    expect(firstAfterLogout.statusCode).toBe(401);

    const secondAfterLogout = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: secondCookie },
    });
    expect(secondAfterLogout.statusCode).toBe(200);

    const logoutAgain = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
    });
    expect(logoutAgain.statusCode).toBe(204);
    expect(logoutAgain.payload).toBe('');
  });

  it('rejects alternate refresh sources and non-empty bodies', async () => {
    const alternate = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh?query_value=alternate',
    });
    expect(alternate.statusCode).toBe(401);
    expect(alternate.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_REFRESH_TOKEN_INVALID' },
    });

    const body = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'alternate' },
    });
    expect(body.statusCode).toBe(400);
    expect(body.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });

    seedActiveAccount();
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const validCookie = cookieOf(login);

    const extraCookie = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${validCookie}; unrelated=value` },
    });
    expect(extraCookie.statusCode).toBe(401);
    expect(extraCookie.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_REFRESH_TOKEN_INVALID' },
    });

    const authorization = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: validCookie,
        authorization: 'Bearer alternate',
      },
    });
    expect(authorization.statusCode).toBe(401);

    const duplicateCookie = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${validCookie}; ${validCookie}` },
    });
    expect(duplicateCookie.statusCode).toBe(401);

    const spacedDuplicate = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: `${validCookie.replace('=', ' =')}; ${validCookie}`,
      },
    });
    expect(spacedDuplicate.statusCode).toBe(401);
  });

  it('clears a rotated cookie when access-token issuance fails after commit', async () => {
    seedActiveAccount();
    const login = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

    c.accessTokenIssuer.fail = true;
    const failed = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    c.accessTokenIssuer.fail = false;

    expect(failed.statusCode).toBe(500);
    expect(String(failed.headers['set-cookie'])).toContain('Max-Age=0');
    expect(failed.payload).not.toContain('access token issuer unavailable');
  });

  void account;
});
