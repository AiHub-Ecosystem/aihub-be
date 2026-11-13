import type { LightMyRequestResponse } from 'fastify';

import {
  type AlternateCredential,
  CLIENT_SECRET,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const LOGOUT_URL = '/v1/auth/web-sessions/logout';

describe('web session HTTP boundary', () => {
  const suite = createWebSessionTestSuite(registerRequestCompletionLog);
  const webSessionHelpers = createWebSessionTestHelpers(
    () => suite.context,
    URL,
  );

  describe('logout', () => {
    beforeEach(() => {
      webSessionHelpers.seedActiveAccount();
    });

    function logout(
      token: unknown,
      options: {
        readonly secret?: string | null;
        readonly headers?: Record<string, string>;
        readonly url?: string;
      } = {},
    ): Promise<LightMyRequestResponse> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...options.headers,
      };
      if (options.secret !== null) {
        headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
      }
      return suite.context.app.inject({
        method: 'POST',
        url: options.url ?? LOGOUT_URL,
        headers,
        payload: { web_session_token: token },
      });
    }

    it('answers a bodyless 204 and ends only the presented session', async () => {
      const thisDevice = await webSessionHelpers.webSessionToken();
      const otherDevice = await webSessionHelpers.webSessionToken();
      expect(suite.context.state.webSessions.size).toBe(2);
      const beforeLogout = new Set(suite.context.state.webSessions.keys());

      const response = await logout(thisDevice);

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');
      expect(response.headers['set-cookie']).toBeUndefined();
      // Exactly one durable row moved, and it is the presented session's. The
      // other device is checked by exchanging it, not by reading its row.
      const revoked = [...suite.context.state.webSessions.values()].filter(
        (session) => session.revokedAt !== undefined,
      );
      expect(revoked).toHaveLength(1);
      expect(beforeLogout.has(revoked[0]?.tokenHash ?? '')).toBe(true);

      expect((await webSessionHelpers.exchange(thisDevice)).statusCode).toBe(
        401,
      );
      expect((await webSessionHelpers.exchange(otherDevice)).statusCode).toBe(
        200,
      );
    });

    it('answers 204 again when the same session is logged out twice', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const first = await logout(token);
      const second = await logout(token);

      expect(first.statusCode).toBe(204);
      expect(second.statusCode).toBe(204);
      expect(second.payload).toBe('');
      expect((await webSessionHelpers.exchange(token)).statusCode).toBe(401);
    });

    it.each([
      [
        'a session that is already revoked',
        async (): Promise<string> => {
          const token = await webSessionHelpers.webSessionToken();
          await logout(token);
          return token;
        },
      ],
      [
        'an unknown token',
        async (): Promise<string> => Promise.resolve('u'.repeat(43)),
      ],
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
        'a malformed token',
        async (): Promise<string> =>
          Promise.resolve('%%% not a web session token %%%'),
      ],
    ])('answers the same bodyless 204 for %s', async (_case, arrange) => {
      const token = await arrange();

      const response = await logout(token);

      // Idempotent and quiet: nothing here distinguishes one from another, so a
      // stale tab can never learn whether its cookie was still worth anything.
      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');
      expect(response.payload).not.toContain(token);
    });

    it.each([
      [
        'a Web Session cookie',
        (token: string): AlternateCredential => ({
          url: LOGOUT_URL,
          headers: { cookie: `__Host-aihub_web_session=${token}` },
        }),
      ],
      [
        'a refresh cookie',
        (token: string): AlternateCredential => ({
          url: LOGOUT_URL,
          headers: { cookie: `__Host-aihub_refresh=${token}` },
        }),
      ],
      [
        'an authorization header',
        (token: string): AlternateCredential => ({
          url: LOGOUT_URL,
          headers: { authorization: `Bearer ${token}` },
        }),
      ],
      [
        'a query parameter',
        (token: string): AlternateCredential => ({
          url: `${LOGOUT_URL}?web_session_token=${token}`,
          headers: {},
        }),
      ],
    ])(
      'answers 204 and revokes nothing for a token offered in %s',
      async (_case, offer) => {
        const token = await webSessionHelpers.webSessionToken();
        const { url, headers } = offer(token);

        const response = await logout(token, { url, headers });

        // The body still carried a valid token, so only the alternate source
        // can explain why nothing was revoked.
        expect(response.statusCode).toBe(204);
        expect(response.payload).toBe('');
        expect((await webSessionHelpers.exchange(token)).statusCode).toBe(200);
      },
    );

    it.each([
      ['a missing client secret', null],
      ['a wrong client secret', 'not-the-secret'],
      ['an empty client secret', ''],
    ])(
      'refuses %s with one generic 401 before any lookup',
      async (_case, secret) => {
        const token = await webSessionHelpers.webSessionToken();
        // A store that would throw if it were reached: the answer stays `401`,
        // so the refusal came first and no row was touched.
        suite.context.webSessions.failRevokeWebSession = true;

        const response = await logout(token, { secret });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'UNAUTHORIZED' },
        });
        expect(suite.context.limiter.calls).toEqual([]);
        // A refused caller logs nobody out.
        expect((await webSessionHelpers.exchange(token)).statusCode).toBe(200);
      },
    );

    it('answers 503 when the store cannot record the revocation', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.webSessions.failRevokeWebSession = true;

      const response = await logout(token);

      // The one failure logout may report: a store that could not record it is a
      // temporary fault the BFF must be able to tell from "already gone", or it
      // would clear a cookie whose session is still live.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('web_session_token');
    });

    it('answers 503 when the deployment provisioned no client secret', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.provisioned.secret = undefined;

      const response = await logout(token);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
    });

    it('marks every response no-store, whatever it answers', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const revoked = await logout(token);
      const refused = await logout(token, { secret: 'wrong' });
      const unavailable = await (async () => {
        suite.context.webSessions.failRevokeWebSession = true;
        return logout('z'.repeat(43));
      })();
      const unknown = await logout('z'.repeat(43));

      for (const response of [revoked, refused, unavailable, unknown]) {
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('rejects an unknown field at the boundary', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const response = await suite.context.app.inject({
        method: 'POST',
        url: LOGOUT_URL,
        headers: {
          'content-type': 'application/json',
          'x-aihub-client-secret': CLIENT_SECRET,
        },
        payload: { web_session_token: token, all_devices: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      expect((await webSessionHelpers.exchange(token)).statusCode).toBe(200);
    });

    it('keeps the client secret and the token out of every log line', async () => {
      const token = await webSessionHelpers.webSessionToken();
      await logout(token);
      await logout(token, { secret: 'wrong-secret-value' });

      const written = suite.context.log.text();
      expect(written).not.toContain(CLIENT_SECRET);
      expect(written).not.toContain('wrong-secret-value');
      expect(written).not.toContain(token);
      for (const [hash] of suite.context.state.webSessions) {
        expect(written).not.toContain(hash);
      }
    });
  });
});
