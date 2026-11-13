import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';

import {
  EMAIL,
  PASSWORD,
  USER_ID,
  createPasswordResetTestHelpers,
  createWebSessionTestHelpers,
  createWebSessionTestSuite,
} from '@/modules/auth/testing/web-session.spec-support';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const RESET_PASSWORD_URL = '/v1/auth/reset-password';

const OTHER_USER_ID = 'usr_01J00000000000000000000001';
const OTHER_EMAIL = 'someone-else@example.com';

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

  function seedOtherActiveAccount(): void {
    seedAccount(suite.context.state, {
      userId: OTHER_USER_ID,
      email: OTHER_EMAIL,
      passwordHash: '$argon2id$fake',
    });
  }

  describe('password reset', () => {
    beforeEach(() => {
      webSessionHelpers.seedActiveAccount();
      seedOtherActiveAccount();
    });

    it('ends every web session of the account and no session of another', async () => {
      const thisDevice = await webSessionHelpers.webSessionToken();
      const otherDevice = await webSessionHelpers.webSessionToken();
      const bystander = await webSessionHelpers.create({
        body: { email: OTHER_EMAIL, password: PASSWORD },
      });
      const bystanderToken = (
        bystander.json() as { data: { web_session_token: string } }
      ).data.web_session_token;
      expect(suite.context.state.webSessions.size).toBe(3);

      const reset = await passwordResetHelpers.resetPassword(
        await passwordResetHelpers.openResetToken(EMAIL, USER_ID),
      );

      expect(reset.statusCode).toBe(204);
      // Whoever knew the old password loses access from every Customer Web
      // device, which is the whole point of ending them here.
      expect((await webSessionHelpers.exchange(thisDevice)).statusCode).toBe(
        401,
      );
      expect((await webSessionHelpers.exchange(otherDevice)).statusCode).toBe(
        401,
      );
      // A different account is untouched: this is not a log-out-everyone route.
      expect(
        (await webSessionHelpers.exchange(bystanderToken)).statusCode,
      ).toBe(200);
      const sessions = [...suite.context.state.webSessions.values()];
      expect(
        sessions
          .filter((session) => session.userId === USER_ID)
          .map((session) => session.revokedAt),
      ).toEqual([suite.context.clock.now(), suite.context.clock.now()]);
      expect(
        sessions
          .filter((session) => session.userId !== USER_ID)
          .map((session) => session.revokedAt),
      ).toEqual([undefined]);
    });

    it('leaves every web session of the account alive when the reset token expired', async () => {
      const token = await webSessionHelpers.webSessionToken();
      const resetToken = await passwordResetHelpers.openResetToken(
        EMAIL,
        USER_ID,
      );
      suite.context.clock.value = new Date(
        [
          ...suite.context.state.passwordResetTokens.values(),
        ][0]?.expiresAt.getTime() ?? 0,
      );

      const response = await passwordResetHelpers.resetPassword(resetToken);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' },
      });
      expect((await webSessionHelpers.exchange(token)).statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().revokedAt).toBeUndefined();
    });

    it('leaves every web session of the account alive for an unknown reset token', async () => {
      const token = await webSessionHelpers.webSessionToken();

      const response = await passwordResetHelpers.resetPassword(
        'never-issued-reset-token',
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' },
      });
      expect((await webSessionHelpers.exchange(token)).statusCode).toBe(200);
      expect(webSessionHelpers.storedSession().revokedAt).toBeUndefined();
    });
  });
});
