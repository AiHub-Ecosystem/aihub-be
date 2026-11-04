import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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

const RequestIdEnvelopeSchema = Type.Object({
  error: Type.Object({ request_id: Type.String({ pattern: '^req_' }) }),
});

describe('local auth HTTP boundary - passwords and reset', () => {
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

  async function openResetToken(): Promise<string> {
    const now = new Date();
    const issued = c.passwordResetTokenIssuer.issue(now);
    await c.passwordResetTokens.issuePasswordResetToken({
      email: EMAIL,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      now,
    });
    return issued.raw;
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

  const passwordBoundaryRequests = [
    {
      name: 'register',
      url: '/v1/auth/register',
      body: { email: EMAIL, username: 'person_01' },
      validStatus: 201,
    },
    {
      name: 'login',
      url: '/v1/auth/login',
      body: { email: EMAIL },
      validStatus: 200,
    },
    {
      name: 'reset-password',
      url: '/v1/auth/reset-password',
      body: {},
      validStatus: 204,
    },
  ];

  const createPasswordBoundaryCases = (lengths: readonly number[]) =>
    passwordBoundaryRequests.flatMap((request) =>
      lengths.flatMap((length) =>
        ['a', '😀'].map((character) => ({
          request,
          length,
          password: character.repeat(length),
        })),
      ),
    );

  const validPasswordBoundaryCases = createPasswordBoundaryCases([12, 128]);
  const invalidPasswordBoundaryCases = createPasswordBoundaryCases([11, 129]);

  it.each(validPasswordBoundaryCases)(
    '$request.name accepts a $length-code-point password',
    async ({ request, password }) => {
      if (request.name !== 'register') {
        seedActiveAccount();
      }
      const body = {
        ...request.body,
        ...(request.name === 'reset-password'
          ? { token: await openResetToken() }
          : {}),
        password,
      };

      const response = await c.app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });

      expect(response.statusCode).toBe(request.validStatus);
    },
  );

  it.each(invalidPasswordBoundaryCases)(
    '$request.name rejects a $length-code-point password generically',
    async ({ request, password }) => {
      const response = await c.app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'content-type': 'application/json' },
        payload: { ...request.body, password },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json<unknown>();
      expect(body).toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request failed validation',
          retryable: false,
        },
      });
      expect(Value.Check(RequestIdEnvelopeSchema, body)).toBe(true);
    },
  );

  it('keeps an identity conflict distinct from an invalid password length', async () => {
    seedActiveAccount();

    const conflict = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        username: 'person_01',
        password: 'a'.repeat(12),
      },
    });
    const invalid = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        username: 'person_01',
        password: 'a'.repeat(11),
      },
    });

    expect([conflict.statusCode, invalid.statusCode]).toEqual([409, 400]);
    expect(conflict.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_IDENTITY_UNAVAILABLE' },
    });
    expect(invalid.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(c.state.accounts.size).toBe(1);
  });

  it('keeps malformed input generic', async () => {
    const malformed = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(c.state.accounts.size).toBe(0);
    expect(c.state.emailDeliveryRequests).toHaveLength(0);
  });

  it.each(['/v1/auth/register', '/v1/auth/login'])(
    'refuses a NUL character in %s as invalid input, not a server error',
    async (url) => {
      const response = await c.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: 'a\u0000b@example.com',
          username: 'nul_probe',
          password: 'correct horse battery staple',
        }),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect(c.state.accounts.size).toBe(0);
    },
  );

  it('returns the generic invalid-token error over HTTP', async () => {
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'invalid-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toMatchObject({
      error: {
        code: 'AUTH_VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid',
      },
    });
  });

  it('resets the password with a bodyless no-store response and clears refresh state', async () => {
    seedActiveAccount();
    const token = await openResetToken();

    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: {
        token,
        password: 'new password that works',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('changes the password and revokes every existing refresh session', async () => {
    c.hasher.verifyByHash = true;
    seedAccount(c.state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: await c.hasher.hash('old password'),
    });
    const token = await openResetToken();

    const firstLogin = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    const secondLogin = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    expect(firstLogin.statusCode).toBe(200);
    expect(secondLogin.statusCode).toBe(200);
    const firstCookie = cookieOf(firstLogin);
    const secondCookie = cookieOf(secondLogin);

    const reset = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new password that works' },
    });
    expect(reset.statusCode).toBe(204);

    const oldPassword = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'new password that works' },
    });
    expect(newPassword.statusCode).toBe(200);

    const firstRefresh = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: firstCookie },
    });
    const secondRefresh = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: secondCookie },
    });
    expect(firstRefresh.statusCode).toBe(401);
    expect(secondRefresh.statusCode).toBe(401);
  });

  it('maps a replayed reset token to the public invalid-token error', async () => {
    seedActiveAccount();
    const token = await openResetToken();
    const payload = {
      method: 'POST' as const,
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
    };

    const first = await c.app.inject({
      ...payload,
      payload: { token, password: 'new password that works' },
    });
    expect(first.statusCode).toBe(204);

    const replay = await c.app.inject({
      ...payload,
      payload: { token, password: 'another password here' },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' },
    });
  });

  // keep helper referenced
  void account;
});
