import { Value } from '@sinclair/typebox/value';

import { MfaRequiredResponseSchema } from '@/contracts/auth/local-auth';
import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  CLIENT_SECRET,
  EMAIL,
  PASSWORD,
  THIRTY_DAYS_MS,
  USER_ID,
  createPasswordResetTestHelpers,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
  expectWebSessionUnavailable,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const RESET_PASSWORD_URL = '/v1/auth/reset-password';

describe('web session HTTP boundary', () => {
  const suite = createWebSessionTestSuite(registerRequestCompletionLog);
  const webSessionHelpers = createWebSessionTestHelpers(
    () => suite.context,
    URL,
  );
  const passwordResetHelpers = createPasswordResetTestHelpers(
    () => suite.context,
    RESET_PASSWORD_URL,
  );

  it('rejects the old password when reset commits during password verification', async () => {
    webSessionHelpers.seedActiveAccount();
    const resetToken = await passwordResetHelpers.openResetToken(
      EMAIL,
      USER_ID,
    );
    const verifying = jest
      .spyOn(suite.context.hasher, 'verify')
      .mockImplementationOnce(async () => {
        expect(
          (await passwordResetHelpers.resetPassword(resetToken)).statusCode,
        ).toBe(204);
        // Argon2 successfully verified the old hash fetched before the reset.
        return true;
      });
    try {
      const response = await webSessionHelpers.create();
      expect(response.statusCode).toBe(401);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'AUTH_CREDENTIALS_INVALID' },
      });
      expect(response.payload).not.toContain('web_session_token');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(suite.context.state.webSessions.size).toBe(0);
      expect(suite.context.limiter.calls.map((call) => call.scope)).toEqual([
        'login_ip',
        'login_email',
      ]);
    } finally {
      verifying.mockRestore();
    }
  });

  it('creates one web session for a valid password and returns its token and expiry in the body', async () => {
    webSessionHelpers.seedActiveAccount();

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(201);
    const body = Value.Parse(
      CreateWebSessionResponseSchema,
      response.json<unknown>(),
    );
    expect(body.data.web_session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.data.expires_at).toBe('2026-11-07T00:00:00.000Z');
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(suite.context.state.webSessions.size).toBe(1);
  });

  it('returns MFA_REQUIRED without issuing a Web Session token', async () => {
    webSessionHelpers.seedActiveAccount();
    suite.context.mfa.loginResult = { kind: 'required' };

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(
      Value.Parse(MfaRequiredResponseSchema, response.json<unknown>()).data,
    ).toEqual({ status: 'MFA_REQUIRED' });
    expect(response.payload).not.toContain('web_session_token');
    expect(suite.context.state.webSessions.size).toBe(0);
  });

  it('stores only the token hash and never sets a cookie', async () => {
    webSessionHelpers.seedActiveAccount();

    const response = await webSessionHelpers.create();
    const token = Value.Parse(
      CreateWebSessionResponseSchema,
      response.json<unknown>(),
    ).data.web_session_token;

    expect(response.headers['set-cookie']).toBeUndefined();
    const [stored] = [...suite.context.state.webSessions.values()];
    expect(stored?.sessionId).toMatch(/^wbs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toBe(token);
    expect(
      JSON.stringify([...suite.context.state.webSessions.values()]),
    ).not.toContain(token);
  });

  it('marks every response no-store, whatever it answers', async () => {
    webSessionHelpers.seedActiveAccount();
    suite.context.provisioned.secret = undefined;
    const unavailable = await webSessionHelpers.create();
    suite.context.provisioned.secret = CLIENT_SECRET;
    const refused = await webSessionHelpers.create({ secret: 'wrong' });
    const invalid = await webSessionHelpers.create({ body: { email: EMAIL } });
    const created = await webSessionHelpers.create();

    for (const response of [unavailable, refused, invalid, created]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it.each([
    ['a missing client secret', null],
    ['a wrong client secret', 'not-the-secret'],
    ['an empty client secret', ''],
  ])(
    'refuses %s with one generic 401 before any lookup',
    async (_case, secret) => {
      webSessionHelpers.seedActiveAccount();

      const response = await webSessionHelpers.create({ secret });

      expect(response.statusCode).toBe(401);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(suite.context.log.completion()['client_ip_source']).toBe(
        'direct_peer',
      );
      expect(suite.context.limiter.calls).toEqual([]);
      expect(suite.context.state.webSessions.size).toBe(0);
    },
  );

  it('labels a Web Session request as the BFF only after the client secret passes', async () => {
    webSessionHelpers.seedActiveAccount();

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(201);
    const completion = suite.context.log.completion();
    expect(typeof completion['client_ip']).toBe('string');
    expect(completion['client_ip_source']).toBe('customer_web_bff');
  });

  it('answers 503 with no credential when the deployment provisioned no secret', async () => {
    webSessionHelpers.seedActiveAccount();
    suite.context.provisioned.secret = undefined;

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(503);
    expectWebSessionUnavailable(response, suite.context.state);
  });

  it('keeps every credential failure generic and consumes the email limit', async () => {
    const rejected = await webSessionHelpers.create();

    expect(rejected.statusCode).toBe(401);
    expect(rejected.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(suite.context.limiter.calls.map((call) => call.scope)).toEqual([
      'login_ip',
      'login_email',
    ]);
    expect(suite.context.state.webSessions.size).toBe(0);
  });

  it.each([
    [
      'a wrong password',
      (): void => {
        webSessionHelpers.seedActiveAccount();
        suite.context.hasher.result = false;
      },
    ],
    ['an unknown email', (): void => {}],
    [
      'a pending-verification account',
      (): void => {
        seedAccount(suite.context.state, {
          userId: USER_ID,
          email: EMAIL,
          passwordHash: '$argon2id$fake',
          status: 'pending_verification',
        });
      },
    ],
    [
      'a disabled account',
      (): void => {
        webSessionHelpers.seedActiveAccount();
        const account = suite.context.state.accounts.get(USER_ID);
        if (account !== undefined) account.status = 'disabled';
      },
    ],
  ])('refuses %s the same way', async (_case, arrange) => {
    arrange();

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(response.payload).not.toContain(EMAIL);
    expect(response.payload).not.toContain('pending_verification');
    expect(response.payload).not.toContain('disabled');
    expect(suite.context.state.webSessions.size).toBe(0);
  });

  // The login limits count failures, exactly as login counts them: a correct
  // password consumes nothing, so a rate-limited caller is one that first failed
  // the credential check.
  it('answers a rate-limited caller 429 rather than a session', async () => {
    suite.context.hasher.result = false;
    suite.context.limiter.allowed = false;

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(429);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect(suite.context.state.webSessions.size).toBe(0);
  });

  it('fails closed with a 503 and no token when the durable write fails', async () => {
    webSessionHelpers.seedActiveAccount();
    suite.context.webSessions.failCreateWebSession = true;

    const response = await webSessionHelpers.create();

    expect(response.statusCode).toBe(503);
    expectWebSessionUnavailable(response, suite.context.state, true);
  });

  it('keeps the client secret and the token out of every log line', async () => {
    webSessionHelpers.seedActiveAccount();
    await webSessionHelpers.create();
    await webSessionHelpers.create({ secret: 'wrong-secret-value' });

    const written = suite.context.log.text();
    expect(written).not.toContain(CLIENT_SECRET);
    expect(written).not.toContain('wrong-secret-value');
    for (const [hash] of suite.context.state.webSessions) {
      expect(written).not.toContain(hash);
    }
  });

  it('expires the session 30 days after creation', async () => {
    webSessionHelpers.seedActiveAccount();
    suite.context.clock.value = new Date('2026-10-08T12:00:00.000Z');

    const response = await webSessionHelpers.create();

    expect(
      Value.Parse(CreateWebSessionResponseSchema, response.json<unknown>()).data
        .expires_at,
    ).toBe('2026-11-07T12:00:00.000Z');
    expect(
      [...suite.context.state.webSessions.values()][0]?.expiresAt.getTime(),
    ).toBe(suite.context.clock.value.getTime() + THIRTY_DAYS_MS);
  });

  it('rejects an unknown field and a malformed password at the boundary', async () => {
    webSessionHelpers.seedActiveAccount();

    const extra = await webSessionHelpers.create({
      body: { email: EMAIL, password: PASSWORD, remember_me: true },
    });
    const short = await webSessionHelpers.create({
      body: { email: EMAIL, password: 'short' },
    });

    expect(extra.statusCode).toBe(400);
    expect(extra.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(short.statusCode).toBe(400);
    expect(suite.context.state.webSessions.size).toBe(0);
  });
});
