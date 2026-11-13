import { Value } from '@sinclair/typebox/value';
import type { LightMyRequestResponse } from 'fastify';
import { decodeJwt } from 'jose';

import { LoginResponseSchema } from '@/contracts/auth/local-auth';
import {
  HOUR_MS,
  NOW,
  THIRTY_DAYS_MS,
  USER_ID,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
/** The issuer and audience this deployment publishes for User Access JWTs. */
const ACCESS_TOKEN_ISSUER = 'https://api.test.aihub.example.com';
const ACCESS_TOKEN_AUDIENCE = 'aihub-user-api:production';

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

    it('answers the login envelope with a User Access JWT the real issuer verifies', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { access_token: string; token_type: string; expires_in: number };
        meta: { request_id: string };
      };
      // The published login contract is the oracle: same fields, same
      // `expires_in`, and nothing else.
      expect(Value.Check(LoginResponseSchema, body)).toBe(true);
      expect(body.data.token_type).toBe('Bearer');
      expect(body.data.expires_in).toBe(900);
      expect(body.meta.request_id).toMatch(/^req_/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      const verified = await suite.context.verifier.verify(
        body.data.access_token,
      );
      expect(verified.userId).toBe(USER_ID);
      expect(verified.jti.length).toBeGreaterThan(0);
    });

    // The exchange uses the same scope-bound issuer as login, so the claim
    // set, audience, and issuer are asserted rather than inferred.
    it('issues the same claim set, audience, and issuer as a login access token', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const response = await webSessionHelpers.exchange(token);

      const claims = decodeJwt(
        (response.json() as { data: { access_token: string } }).data
          .access_token,
      );
      expect(Object.keys(claims).sort()).toEqual([
        'aud',
        'exp',
        'iat',
        'iss',
        'jti',
        'session',
        'sub',
      ]);
      expect(claims['session']).toEqual({
        kind: 'web',
        id: webSessionHelpers.storedSession().sessionId,
      });
      expect(claims.sub).toBe(USER_ID);
      expect(claims.iss).toBe(ACCESS_TOKEN_ISSUER);
      expect(claims.aud).toBe(ACCESS_TOKEN_AUDIENCE);
      // The published 15-minute maximum, in the token itself. `Number` keeps a
      // missing claim a failure instead of a silent zero.
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    });

    it('signs a different JWT on every exchange', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const first = await webSessionHelpers.exchange(token);
      const second = await webSessionHelpers.exchange(token);

      const accessTokenOf = (response: LightMyRequestResponse): string =>
        (response.json() as { data: { access_token: string } }).data
          .access_token;
      expect(accessTokenOf(first)).not.toBe(accessTokenOf(second));
      expect(
        (await suite.context.verifier.verify(accessTokenOf(first))).jti,
      ).not.toBe(
        (await suite.context.verifier.verify(accessTokenOf(second))).jti,
      );
    });

    it('slides the expiry 30 days forward on a successful exchange', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.clock.value = new Date(NOW.getTime() + 24 * HOUR_MS);

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().expiresAt.getTime()).toBe(
        suite.context.clock.value.getTime() + THIRTY_DAYS_MS,
      );
      // AIHUB stores nothing about the JWT it signed: the only durable state
      // an exchange moves is the session's own expiry.
      expect(
        JSON.stringify([...suite.context.state.webSessions.values()]),
      ).not.toContain(
        (response.json() as { data: { access_token: string } }).data
          .access_token,
      );
    });

    it('writes no renewal inside the throttle window and renews after it', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const createdExpiry = webSessionHelpers
        .storedSession()
        .expiresAt.getTime();
      const createdRenewal = webSessionHelpers
        .storedSession()
        .lastRenewedAt.getTime();

      // Ten minutes of console activity, then two hours of it: the first burst
      // must not turn every exchange into a row update.
      suite.context.clock.value = new Date(NOW.getTime() + 10 * 60 * 1000);
      const early = await webSessionHelpers.exchange(token);

      expect(early.statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().expiresAt.getTime()).toBe(
        createdExpiry,
      );
      expect(webSessionHelpers.storedSession().lastRenewedAt.getTime()).toBe(
        createdRenewal,
      );

      suite.context.clock.value = new Date(NOW.getTime() + 2 * HOUR_MS);
      const later = await webSessionHelpers.exchange(token);

      expect(later.statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().expiresAt.getTime()).toBe(
        suite.context.clock.value.getTime() + THIRTY_DAYS_MS,
      );
      expect(webSessionHelpers.storedSession().lastRenewedAt.getTime()).toBe(
        suite.context.clock.value.getTime(),
      );
    });

    it('never moves the expiry backwards', async () => {
      const token = await webSessionHelpers.webSessionToken();
      // A session that already expires later than 30 days from now, whose last
      // renewal is old enough to clear the throttle: the only thing left to
      // refuse is a renewal that would shorten it.
      const row = webSessionHelpers.storedSession();
      const farFuture = new Date(
        suite.context.clock.value.getTime() + 60 * 24 * HOUR_MS,
      );
      row.expiresAt = farFuture;
      row.lastRenewedAt = new Date(
        suite.context.clock.value.getTime() - 40 * 24 * HOUR_MS,
      );

      const response = await webSessionHelpers.exchange(token);

      expect(response.statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().expiresAt.getTime()).toBe(
        farFuture.getTime(),
      );
    });

    it('answers 503 with no credential when the renewal write fails', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const createdExpiry = webSessionHelpers
        .storedSession()
        .expiresAt.getTime();
      suite.context.webSessions.failRenewWebSession = true;

      const response = await webSessionHelpers.exchange(token);

      // Fail closed. A renewal AIHUB could not record is a temporary fault the
      // BFF must be able to tell from a bad session, so it keeps its cookie
      // instead of receiving a JWT for an exchange that never committed.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('access_token');
      expect(webSessionHelpers.storedSession().expiresAt.getTime()).toBe(
        createdExpiry,
      );
    });

    it('answers every concurrent exchange of one session', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const responses = await Promise.all([
        webSessionHelpers.exchange(token),
        webSessionHelpers.exchange(token),
        webSessionHelpers.exchange(token),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200, 200,
      ]);
      const jtis = await Promise.all(
        responses.map(
          async (response) =>
            (
              await suite.context.verifier.verify(
                (response.json() as { data: { access_token: string } }).data
                  .access_token,
              )
            ).jti,
        ),
      );
      expect(new Set(jtis).size).toBe(3);
      expect(suite.context.state.webSessions.size).toBe(1);
    });

    it('refuses a session unused for exactly 30 days and answers one millisecond before', async () => {
      const token = await webSessionHelpers.webSessionToken();
      suite.context.clock.value = new Date(
        webSessionHelpers.storedSession().expiresAt.getTime() - 1,
      );

      const stillValid = await webSessionHelpers.exchange(token);

      expect(stillValid.statusCode).toBe(200);
      suite.context.clock.value = new Date(
        webSessionHelpers.storedSession().expiresAt.getTime(),
      );
      const expired = await webSessionHelpers.exchange(token);

      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_INVALID' },
      });
    });
  });
});
