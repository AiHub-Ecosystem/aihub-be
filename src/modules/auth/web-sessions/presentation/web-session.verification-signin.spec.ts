import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import { Value } from '@sinclair/typebox/value';
import type { LightMyRequestResponse } from 'fastify';

import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import {
  CLIENT_SECRET,
  EMAIL,
  NOW,
  USER_ID,
  createWebSessionTestSuite,
  expectWebSessionUnavailable,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const VERIFICATION_URL = '/v1/auth/web-sessions/verification';
const VERIFY_EMAIL_URL = '/v1/auth/verify-email';
const BINDING = 'b'.repeat(43);
const VERIFICATION_TOKEN_VALUE = 'verification-token-value-under-test';

describe('web session HTTP boundary', () => {
  const suite = createWebSessionTestSuite(registerRequestCompletionLog);

  function seedVerificationAccount(requiresPassword = false): void {
    seedAccount(suite.context.state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: '$argon2id$fake',
      status: 'pending_verification',
    });
    suite.context.state.verificationTokens.set(
      `hash:${VERIFICATION_TOKEN_VALUE}`,
      {
        tokenId: 'evt_01J00000000000000000000000',
        userId: USER_ID,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        browserBindingHash: `hash:${BINDING}`,
        consumedAt: undefined,
        consumedReason: undefined,
        signedInAt: undefined,
        ...(requiresPassword
          ? { requiresPassword: true, passwordFailures: 0 }
          : {}),
      },
    );
  }

  describe('verification password (ADR-0123)', () => {
    beforeEach(() => {
      seedVerificationAccount(true);
    });

    const post = (url: string, body: Record<string, unknown>) =>
      suite.context.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-aihub-client-secret': CLIENT_SECRET,
        },
        payload: { token: VERIFICATION_TOKEN_VALUE, ...body },
      });

    describe.each([
      ['verify-email', VERIFY_EMAIL_URL],
      ['the Web Session verification route', VERIFICATION_URL],
    ])('on %s', (_name, url) => {
      it('refuses a token that needs the password when none is sent, and verifies nothing', async () => {
        const response = await post(url, { browser_binding: BINDING });

        expect(response.statusCode).toBe(400);
        expect(response.json<unknown>()).toMatchObject({
          error: { code: 'AUTH_VERIFICATION_PASSWORD_INVALID' },
        });
        expect(suite.context.state.accounts.get(USER_ID)?.status).toBe(
          'pending_verification',
        );
        expect(
          suite.context.state.webSessions.size +
            suite.context.state.refreshTokens.size,
        ).toBe(0);
      });

      it('refuses and counts a wrong password', async () => {
        suite.context.hasher.result = false;

        const response = await post(url, { password: 'not it' });

        expect(response.statusCode).toBe(400);
        expect(response.json<unknown>()).toMatchObject({
          error: { code: 'AUTH_VERIFICATION_PASSWORD_INVALID' },
        });
        expect(
          suite.context.state.verificationTokens.get(
            `hash:${VERIFICATION_TOKEN_VALUE}`,
          )?.passwordFailures,
        ).toBe(1);
        expect(suite.context.state.accounts.get(USER_ID)?.status).toBe(
          'pending_verification',
        );
      });

      it('verifies with the registration password', async () => {
        const response = await post(url, { password: 'registered password' });

        expect(response.statusCode).toBe(204);
        expect(suite.context.state.accounts.get(USER_ID)?.status).toBe(
          'active',
        );
      });
    });
  });

  describe('Verification Sign-in', () => {
    beforeEach(() => {
      seedVerificationAccount();
    });

    function signIn(
      options: {
        readonly secret?: string | null;
        readonly body?: unknown;
      } = {},
    ): Promise<LightMyRequestResponse> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (options.secret !== null) {
        headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
      }
      return suite.context.app.inject({
        method: 'POST',
        url: VERIFICATION_URL,
        headers,
        payload: options.body ?? {
          token: VERIFICATION_TOKEN_VALUE,
          browser_binding: BINDING,
        },
      });
    }

    it('creates one web session for a bound token and returns its token and expiry in the body', async () => {
      const response = await signIn();

      expect(response.statusCode).toBe(201);
      const body = Value.Parse(
        CreateWebSessionResponseSchema,
        response.json<unknown>(),
      );
      expect(body.data.web_session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.data.expires_at).toBe('2026-11-07T00:00:00.000Z');
      expect(body.meta.request_id).toMatch(/^req_/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(suite.context.state.webSessions.size).toBe(1);
      expect([...suite.context.state.webSessions.values()][0]?.userId).toBe(
        USER_ID,
      );
      expect(suite.context.state.refreshTokens.size).toBe(0);
      expect(suite.context.state.accounts.get(USER_ID)?.status).toBe('active');
    });

    it.each([
      ['no binding', {}],
      ['a different browser', { browser_binding: 'c'.repeat(43) }],
    ])(
      'verifies the email but signs nobody in with %s',
      async (_case, extra) => {
        const response = await signIn({
          body: { token: VERIFICATION_TOKEN_VALUE, ...extra },
        });

        expect(response.statusCode).toBe(204);
        expect(response.payload).toBe('');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(suite.context.state.webSessions.size).toBe(0);
        expect(suite.context.state.accounts.get(USER_ID)?.status).toBe(
          'active',
        );
      },
    );

    it('creates nothing further on a replay after a successful sign-in', async () => {
      await signIn();

      const replay = await signIn();

      expect(replay.statusCode).toBe(204);
      expect(suite.context.state.webSessions.size).toBe(1);
    });

    it('creates at most one session in total across both session kinds', async () => {
      await signIn();
      const viaVerifyEmail = await suite.context.app.inject({
        method: 'POST',
        url: VERIFY_EMAIL_URL,
        headers: { 'content-type': 'application/json' },
        payload: { token: VERIFICATION_TOKEN_VALUE, browser_binding: BINDING },
      });

      expect(viaVerifyEmail.statusCode).toBe(204);
      expect(suite.context.state.refreshTokens.size).toBe(0);
      expect(suite.context.state.webSessions.size).toBe(1);
    });

    it('creates no web session for a token a verify already spent on a refresh session', async () => {
      const viaVerifyEmail = await suite.context.app.inject({
        method: 'POST',
        url: VERIFY_EMAIL_URL,
        headers: { 'content-type': 'application/json' },
        payload: { token: VERIFICATION_TOKEN_VALUE, browser_binding: BINDING },
      });
      expect(viaVerifyEmail.statusCode).toBe(200);

      const response = await signIn();

      expect(response.statusCode).toBe(204);
      expect(suite.context.state.webSessions.size).toBe(0);
      expect(suite.context.state.refreshTokens.size).toBe(1);
    });

    it('creates at most one web session for concurrent submissions of the same token', async () => {
      const responses = await Promise.all([signIn(), signIn(), signIn()]);

      const created = responses.filter(
        (response) => response.statusCode === 201,
      );
      expect(created).toHaveLength(1);
      expect(suite.context.state.webSessions.size).toBe(1);
    });

    it('answers an invalid verification token the same failure as the verify route', async () => {
      const response = await signIn({ body: { token: 'not-a-real-token' } });

      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'AUTH_VERIFICATION_TOKEN_INVALID' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(suite.context.state.webSessions.size).toBe(0);
    });

    it('bounds BFF verification attempts by the token hash', async () => {
      suite.context.limiter.allowed = false;

      const response = await signIn();

      expect(response.statusCode).toBe(429);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
      expect(suite.context.limiter.calls.map((call) => call.scope)).toEqual([
        'web_session_verification_token',
      ]);
      expect(suite.context.state.webSessions.size).toBe(0);
    });

    it.each([
      ['a missing client secret', null],
      ['a wrong client secret', 'not-the-secret'],
    ])(
      'refuses %s before the token is even looked at',
      async (_case, secret) => {
        const response = await signIn({ secret });

        expect(response.statusCode).toBe(401);
        expect(response.json<unknown>()).toMatchObject({
          error: { code: 'UNAUTHORIZED' },
        });
        expect(suite.context.limiter.calls).toEqual([]);
        expect(suite.context.state.webSessions.size).toBe(0);
        expect(suite.context.state.accounts.get(USER_ID)?.status).toBe(
          'pending_verification',
        );
      },
    );

    it('answers 503 with no credential when no client secret is provisioned', async () => {
      suite.context.provisioned.secret = undefined;

      const response = await signIn();

      expect(response.statusCode).toBe(503);
      expectWebSessionUnavailable(response, suite.context.state);
    });

    it('fails closed with a 503 and no token when the durable write fails', async () => {
      suite.context.verificationTokens.failSessionWrite = true;

      const response = await signIn();

      expect(response.statusCode).toBe(503);
      expectWebSessionUnavailable(response, suite.context.state, true);
    });

    it('rejects an unknown field and a malformed binding at the boundary', async () => {
      const extra = await signIn({
        body: {
          token: VERIFICATION_TOKEN_VALUE,
          browser_binding: BINDING,
          sign_in: true,
        },
      });
      const malformed = await signIn({
        body: { token: VERIFICATION_TOKEN_VALUE, browser_binding: 'too-short' },
      });

      expect(extra.statusCode).toBe(400);
      expect(extra.json<unknown>()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(suite.context.state.webSessions.size).toBe(0);
    });

    it('keeps the client secret, the token, and the binding out of every log line', async () => {
      await signIn();
      await signIn({ secret: 'wrong-secret-value' });

      const written = suite.context.log.text();
      expect(written).not.toContain(CLIENT_SECRET);
      expect(written).not.toContain('wrong-secret-value');
      expect(written).not.toContain(BINDING);
      for (const [hash] of suite.context.state.webSessions) {
        expect(written).not.toContain(hash);
      }
    });
  });
});
