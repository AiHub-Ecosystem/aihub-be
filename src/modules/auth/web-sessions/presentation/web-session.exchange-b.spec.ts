import {
  type AlternateCredential,
  CLIENT_SECRET,
  USER_ID,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';

describe('web session HTTP boundary', () => {
  const suite = createWebSessionTestSuite(registerRequestCompletionLog);
  const webSessionHelpers = createWebSessionTestHelpers(
    () => suite.context,
    URL,
  );

  describe('exchange', () => {
    beforeEach(() => {
      webSessionHelpers.seedActiveAccount();
    });

    it('refuses a disabled account and leaves its sessions in place', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const account = suite.context.state.accounts.get(USER_ID);
      if (account === undefined) {
        throw new Error('the account was never seeded');
      }
      account.status = 'disabled';

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_INVALID' },
      });
      // Disabling stops the session, it does not delete it: re-enabling the
      // account restores it, which is why nothing is revoked here.
      expect(suite.context.state.webSessions.size).toBe(1);
      expect(webSessionHelpers.storedSession().revokedAt).toBeUndefined();
    });

    it.each([
      [
        'an expired session',
        async (): Promise<string> => {
          const token = await webSessionHelpers.webSessionToken();
          suite.context.clock.value = new Date(
            webSessionHelpers.storedSession().expiresAt.getTime(),
          );
          return token;
        },
      ],
      [
        'a revoked session',
        async (): Promise<string> => {
          const token = await webSessionHelpers.webSessionToken();
          webSessionHelpers.storedSession().revokedAt =
            suite.context.clock.value;
          return token;
        },
      ],
      [
        'an unknown token',
        async (): Promise<string> => Promise.resolve('t'.repeat(43)),
      ],
      [
        'a malformed token',
        async (): Promise<string> =>
          Promise.resolve('%%% not a web session token %%%'),
      ],
    ])('answers one generic 401 for %s', async (_case, arrange) => {
      const token = await arrange();

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_INVALID' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      // Nothing that distinguishes one unusable session from another.
      expect(response.payload).not.toContain(token);
      expect(response.payload).not.toContain('expired');
      expect(response.payload).not.toContain('revoked');
    });

    it.each([
      [
        'a Web Session cookie',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { cookie: `__Host-aihub_web_session=${token}` },
        }),
      ],
      [
        'a refresh cookie',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { cookie: `__Host-aihub_refresh=${token}` },
        }),
      ],
      [
        'an authorization header',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { authorization: `Bearer ${token}` },
        }),
      ],
      [
        'a query parameter',
        (token: string): AlternateCredential => ({
          url: `${EXCHANGE_URL}?web_session_token=${token}`,
          headers: {},
        }),
      ],
    ])(
      'refuses a token offered in %s rather than reading it',
      async (_case, offer) => {
        const token = await webSessionHelpers.webSessionToken();
        // The body still carries a valid token, so only the alternate source
        // can explain the refusal.
        const { url, headers } = offer(token);

        const response = await suite.context.app.inject({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            'x-aihub-client-secret': CLIENT_SECRET,
            ...headers,
          },
          payload: { web_session_token: token },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'AUTH_WEB_SESSION_INVALID' },
        });
      },
    );

    it.each([
      ['a missing client secret', null],
      ['a wrong client secret', 'not-the-secret'],
      ['an empty client secret', ''],
    ])('refuses %s before any session lookup', async (_case, secret) => {
      const token = await webSessionHelpers.webSessionToken();
      // A store that would throw if it were reached: the answer stays `401`,
      // so the refusal came first and no row was looked up.
      suite.context.webSessions.failFindWebSession = true;

      const response = await webSessionHelpers.exchange(token, {
        secret,
        headers: { 'x-aihub-end-user-ip': '198.51.100.55' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(suite.context.limiter.calls).toEqual([]);
      // The session survives a refused caller: only the exchange was refused.
      expect(suite.context.state.webSessions.size).toBe(1);
    });

    it('consumes the exchange limits on a failure and nothing on a success', async () => {
      const failed = await webSessionHelpers.exchange('t'.repeat(43));

      expect(failed.statusCode).toBe(401);
      expect(suite.context.limiter.calls.map((call) => call.scope)).toEqual([
        'web_session_exchange_token',
      ]);
      // The per-token key is the stored hash, never the credential itself.
      const token = await webSessionHelpers.webSessionToken();
      suite.context.limiter.calls = [];
      const renewed = await webSessionHelpers.exchange(token);

      expect(renewed.statusCode).toBe(200);
      expect(suite.context.limiter.calls).toEqual([]);
    });

    it('answers a rate-limited caller 429 rather than a JWT', async () => {
      suite.context.limiter.allowed = false;

      const response = await webSessionHelpers.exchange('t'.repeat(43));

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 with no credential when the store cannot be read', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.webSessions.failFindWebSession = true;

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 when the deployment provisioned no client secret', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.provisioned.secret = undefined;

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('access_token');
    });

    it('marks every response no-store, whatever it answers', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const refused = await webSessionHelpers.exchange('t'.repeat(43));
      const invalid = await suite.context.app.inject({
        method: 'POST',
        url: EXCHANGE_URL,
        headers: { 'content-type': 'application/json' },
        payload: { web_session_token: token, remember_me: true },
      });
      const exchanged = await webSessionHelpers.exchange(token);

      for (const response of [refused, invalid, exchanged]) {
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('keeps the client secret, the token, and the JWT out of every log line', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const exchanged = await webSessionHelpers.exchange(token);
      await webSessionHelpers.exchange(token, { secret: 'wrong-secret-value' });

      const written = suite.context.log.text();
      expect(written).not.toContain(CLIENT_SECRET);
      expect(written).not.toContain('wrong-secret-value');
      expect(written).not.toContain(token);
      expect(written).not.toContain(
        (exchanged.json() as { data: { access_token: string } }).data
          .access_token,
      );
    });
  });
});
