import {
  CLIENT_SECRET,
  EMAIL,
  USER_ID,
  createPasswordResetTestHelpers,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import {
  USER_ACCESS_TOKEN_ISSUER,
  type UserAccessTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const VERIFICATION_URL = '/v1/auth/web-sessions/verification';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
const LOGOUT_URL = '/v1/auth/web-sessions/logout';
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

  describe('revocation racing an exchange', () => {
    beforeEach(() => webSessionHelpers.seedActiveAccount());

    it.each(['logout', 'password reset'] as const)(
      'returns no JWT when %s commits while signing is in flight',
      async (action) => {
        const token = await webSessionHelpers.webSessionToken();
        const resetToken =
          action === 'password reset'
            ? await passwordResetHelpers.openResetToken(EMAIL, USER_ID)
            : undefined;
        const issuer = suite.context.app.get<UserAccessTokenIssuerPort>(
          USER_ACCESS_TOKEN_ISSUER,
        );
        const issue = issuer.issue.bind(issuer);
        const paused = jest
          .spyOn(issuer, 'issue')
          .mockImplementationOnce(async (userId) => {
            const revoked =
              resetToken === undefined
                ? await suite.context.app.inject({
                    method: 'POST',
                    url: LOGOUT_URL,
                    headers: { 'x-aihub-client-secret': CLIENT_SECRET },
                    payload: { web_session_token: token },
                  })
                : await passwordResetHelpers.resetPassword(resetToken);
            expect(revoked.statusCode).toBe(204);
            return issue(userId);
          });
        try {
          const response = await webSessionHelpers.exchange(token);
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({
            error: { code: 'AUTH_WEB_SESSION_INVALID' },
          });
          expect(response.payload).not.toContain('access_token');
          expect(response.headers['cache-control']).toBe('no-store');
        } finally {
          paused.mockRestore();
        }
      },
    );
  });

  it('fails closed when the final validity read is unavailable after signing', async () => {
    webSessionHelpers.seedActiveAccount();
    const token = await webSessionHelpers.webSessionToken();
    const issuer = suite.context.app.get<UserAccessTokenIssuerPort>(
      USER_ACCESS_TOKEN_ISSUER,
    );
    const issue = issuer.issue.bind(issuer);
    const unavailable = jest
      .spyOn(issuer, 'issue')
      .mockImplementationOnce(async (userId) => {
        const signed = await issue(userId);
        suite.context.webSessions.failFindWebSession = true;
        return signed;
      });
    try {
      const response = await webSessionHelpers.exchange(token);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('access_token');
    } finally {
      unavailable.mockRestore();
    }
  });

  it.each([URL, VERIFICATION_URL, EXCHANGE_URL, LOGOUT_URL])(
    'authenticates the BFF before validating the body on %s',
    async (url) => {
      const response = await suite.context.app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { unexpected: 'field' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});
