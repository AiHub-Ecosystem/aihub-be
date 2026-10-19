import { Value } from '@sinclair/typebox/value';

import { ReadCurrentUserResponseSchema } from '@/contracts/auth/local-auth';
import {
  type InMemoryAccount,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  type LocalAuthTestContext,
  RECOVERY_MESSAGE,
  USER_ID,
  createLocalAuthTestContext,
} from '@/modules/auth/testing/local-auth.controller.spec-support';

describe('local auth HTTP boundary - access, registration, and rate limits', () => {
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

  function issuedVerificationToken(index = 0): string {
    const token = c.tokenIssuer.issued[index];
    if (token === undefined) {
      throw new Error(`no verification token was issued at position ${index}`);
    }
    return token.raw;
  }

  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const setCookie = response.headers['set-cookie'];
    if (setCookie === undefined) {
      throw new Error('the response set no refresh cookie');
    }
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return (cookie ?? '').split(';', 1)[0] ?? '';
  }

  function sealed(
    request: { readonly payloadCiphertext: string } | undefined,
  ): any {
    if (request === undefined) {
      throw new Error('no email delivery request was written');
    }
    return JSON.parse(c.cipher.decrypt(request.payloadCiphertext));
  }

  it('uses the address nginx appends for separate local-auth IP budgets', async () => {
    c.limiter.blockedKeys.add('login_ip:198.51.100.10');

    const blockedCaller = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '172.16.7.1',
      headers: {
        'x-forwarded-for': '198.51.100.11, 198.51.100.10',
      },
      payload: { email: 'blocked@example.com', password: 'wrong password' },
    });
    const otherCaller = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '172.16.7.1',
      headers: {
        'x-forwarded-for': '198.51.100.10, 198.51.100.11',
      },
      payload: { email: 'other@example.com', password: 'wrong password' },
    });

    expect(blockedCaller.statusCode).toBe(429);
    expect(otherCaller.statusCode).toBe(401);
    expect(
      c.limiter.calls
        .filter((call) => call.scope === 'login_ip')
        .map((call) => call.key),
    ).toEqual(['198.51.100.10', '198.51.100.11']);
  });

  it.each([
    ['/v1/auth/register', 'register'],
    ['/v1/auth/resend-verification', 'resend'],
    ['/v1/auth/forgot-password', 'forgot'],
  ] as const)(
    'keeps the shared mail-request budget caller-scoped when the next request uses %s',
    async (url, route) => {
      const email = 'Person@Example.com';
      const send = async (
        remoteAddress: string,
        targetUrl: string,
        targetEmail = email,
      ) =>
        c.app.inject({
          method: 'POST',
          url: targetUrl,
          remoteAddress,
          headers: { 'content-type': 'application/json' },
          payload:
            targetUrl === '/v1/auth/register'
              ? {
                  email: targetEmail,
                  username: 'budget_user',
                  password: 'correct horse battery',
                }
              : { email: targetEmail },
        });

      const callerOne = '192.0.2.10';
      const callerTwo = '192.0.2.11';
      expect(
        (await send(callerOne, '/v1/auth/forgot-password')).statusCode,
      ).toBe(202);
      expect(
        (
          await send(
            callerOne,
            '/v1/auth/resend-verification',
            ' person@example.com ',
          )
        ).statusCode,
      ).toBe(202);
      expect(
        (
          await send(
            callerOne,
            '/v1/auth/forgot-password',
            'PERSON@example.com',
          )
        ).statusCode,
      ).toBe(202);

      const blocked = await send(
        callerOne,
        '/v1/auth/register',
        'person@example.com',
      );
      expect(blocked.statusCode).toBe(429);

      const otherCaller = await send(callerTwo, url);
      expect(otherCaller.statusCode).toBe(route === 'register' ? 201 : 202);
    },
  );

  it('answers an exhausted mail budget with the longest wait and the header that agrees with it', async () => {
    const send = () =>
      c.app.inject({
        method: 'POST',
        url: '/v1/auth/forgot-password',
        remoteAddress: '192.0.2.30',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'person@example.com' },
      });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await send()).statusCode).toBe(202);
    }

    const blocked = await send();

    expect(blocked.statusCode).toBe(429);
    const error = blocked.json().error;
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(error.retry_after_ms).toBeGreaterThan(23 * 60 * 60_000);
    expect(blocked.headers['retry-after']).toBe(
      String(Math.ceil(error.retry_after_ms / 1_000)),
    );
  });

  it('returns only the authenticated account username with no-store caching', async () => {
    seedActiveAccount();

    const response = await c.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer valid.user.access' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Value.Check(ReadCurrentUserResponseSchema, response.json())).toBe(
      true,
    );
    expect(response.json()).toEqual({
      data: { username: 'person_01' },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
  });

  it('returns enrollment material and recovery codes only from their no-store MFA endpoints', async () => {
    seedActiveAccount();
    const headers = {
      authorization: 'Bearer valid.user.access',
      'content-type': 'application/json',
    };

    const enrollment = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrollment',
      headers,
      payload: { password: 'correct horse battery' },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.headers['cache-control']).toBe('no-store');
    expect(enrollment.json().data).toEqual({
      secret: 'A'.repeat(32),
      otpauth_uri: 'otpauth://totp/AIHUB:test',
    });

    const confirmation = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrollment/confirm',
      headers,
      payload: { code: '123456' },
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.headers['cache-control']).toBe('no-store');
    expect(confirmation.json().data.recovery_codes).toEqual([
      'ABCD-EFGH-IJKL-MNOP',
    ]);

    const removal = await c.app.inject({
      method: 'DELETE',
      url: '/v1/auth/mfa',
      headers,
      payload: { password: 'correct horse battery' },
    });
    expect(removal.statusCode).toBe(204);
    expect(removal.headers['cache-control']).toBe('no-store');
  });

  it('requires a Bearer user access token for the current account', async () => {
    const response = await c.app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_USER_ACCESS_TOKEN_REQUIRED');
  });

  it('registers and acknowledges first and repeated verification through HTTP', async () => {
    const register = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ' Person@Example.com ',
        username: ' Person_01 ',
        password: 'correct horse battery',
      },
    });

    expect(register.statusCode).toBe(201);
    expect(register.json()).toEqual({
      data: {
        email: 'person@example.com',
        username: 'person_01',
        status: 'pending_verification',
        email_delivery_status: 'queued',
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    expect(register.payload).not.toContain('argon2');
    const token = issuedVerificationToken();

    const verify = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(verify.statusCode).toBe(204);
    expect(verify.payload).toBe('');
    expect(verify.headers['set-cookie']).toBeUndefined();

    const replay = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(replay.statusCode).toBe(204);
    expect(replay.payload).toBe('');
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('returns a bodyless generic 202 for resend', async () => {
    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.payload).toBe('');
    expect(c.state.verificationTokens.size).toBe(0);
  });

  it.each([
    ['unknown', false],
    ['known', true],
  ])(
    'returns the same recovery envelope for a %s account',
    async (_label, eligible) => {
      if (eligible) {
        seedActiveAccount();
      }

      const response = await c.app.inject({
        method: 'POST',
        url: '/v1/auth/forgot-password',
        headers: { 'content-type': 'application/json' },
        payload: { email: ' Person@Example.com ' },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { message: RECOVERY_MESSAGE },
        meta: { request_id: expect.stringMatching(/^req_/) },
      });
      expect(response.payload).not.toContain('reset-token');
    },
  );

  it('queues reset instructions instead of sending them in the request path', async () => {
    seedActiveAccount();

    const response = await c.app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: { email: ' Person@Example.com ' },
    });

    expect(response.statusCode).toBe(202);
    expect(c.state.emailDeliveryRequests).toHaveLength(1);
    expect(sealed(c.state.emailDeliveryRequests[0])).toMatchObject({
      email: EMAIL,
      token: 'reset-token-1',
    });
    expect(response.payload).not.toContain('reset-token');
  });
});
