import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  RECOVERY_MESSAGE,
  USER_ID,
  backlogged,
  issuedToken,
  localAuth,
  refusal,
  seedActiveAccount,
} from '@/modules/auth/testing/local-credentials.spec-support';

describe('PasswordRecoveryService', () => {
  describe('email outbox backpressure', () => {
    it('refuses a password recovery request for every address, known or not', async () => {
      const { recovery, state, limiter, refusals } = localAuth(backlogged);
      seedActiveAccount(state);

      await expect(
        refusal(recovery.forgotPassword({ email: EMAIL }, '203.0.113.7')),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });
      await expect(
        refusal(
          recovery.forgotPassword(
            { email: 'nobody@example.com' },
            '203.0.113.7',
          ),
        ),
      ).resolves.toMatchObject({ code: 'EMAIL_DELIVERY_BACKLOGGED' });

      expect(limiter.calls).toEqual([]);
      expect(state.passwordResetTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toEqual([]);
      expect(refusals).toEqual([
        'password_reset_email',
        'password_reset_email',
      ]);
    });
  });

  it('returns one recovery message for an active target and keeps its rate limits', async () => {
    const { recovery, state, limiter, passwordResetTokenIssuer } = localAuth();
    seedActiveAccount(state);

    await expect(
      recovery.forgotPassword({ email: ' Person@Example.com ' }, '203.0.113.7'),
    ).resolves.toEqual({ message: RECOVERY_MESSAGE });
    expect([...state.passwordResetTokens.keys()]).toEqual([
      passwordResetTokenIssuer.hash('reset-token-1'),
    ]);
    expect(state.emailDeliveryRequests).toHaveLength(1);
    expect(state.emailDeliveryRequests[0]?.payload).toEqual({
      email: EMAIL,
      token: 'reset-token-1',
      expiresAt: passwordResetTokenIssuer.issued[0]?.expiresAt.toISOString(),
    });
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'forgot_ip',
          limit: 3,
          windowMs: 900000,
        }),
        expect.objectContaining({
          scope: 'auth_email_request',
          limit: 3,
          windowMs: 86400000,
        }),
      ]),
    );
  });

  it.each([
    ['unknown', undefined],
    ['pending', 'pending_verification'],
    ['disabled', 'disabled'],
  ] as const)(
    'accepts a conditional send for a %s account without writing a request',
    async (_label, status) => {
      const { recovery, state } = localAuth();
      if (status !== undefined) {
        seedAccount(state, {
          userId: USER_ID,
          email: EMAIL,
          username: 'person_01',
          passwordHash: 'argon2:correct horse battery',
          status,
        });
      }

      await expect(
        recovery.forgotPassword({ email: EMAIL }, '203.0.113.7'),
      ).resolves.toEqual({ message: RECOVERY_MESSAGE });
      expect(state.passwordResetTokens.size).toBe(0);
      expect(state.emailDeliveryRequests).toHaveLength(0);
    },
  );

  it.each([11, 129])(
    'returns a generic invalid request for a %i-code-point reset password',
    async (length) => {
      const { recovery } = localAuth();

      await expect(
        recovery.resetPassword(
          { token: 'reset-token-1', password: 'a'.repeat(length) },
          '203.0.113.7',
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        httpStatus: 400,
      });
    },
  );

  it('resets once, then maps the replayed token to one public error that counts as a failure', async () => {
    const { recovery, state, limiter, hasher, passwordResetTokenIssuer } =
      localAuth();
    seedActiveAccount(state);
    await recovery.forgotPassword({ email: EMAIL }, '203.0.113.7');
    const token = issuedToken(passwordResetTokenIssuer.issued);

    await expect(
      recovery.resetPassword(
        { token, password: 'new password that works' },
        '203.0.113.7',
      ),
    ).resolves.toBeUndefined();
    expect(hasher.hashed).toEqual(['new password that works']);
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'reset_ip' }),
        expect.objectContaining({ scope: 'reset_token' }),
      ]),
    );
    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      'argon2:new password that works',
    );

    await expect(
      recovery.resetPassword(
        { token, password: 'another password here' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
      httpStatus: 400,
    });
    expect(hasher.hashed).toHaveLength(1);
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'reset_ip',
          limit: 10,
          windowMs: 300000,
        }),
        expect.objectContaining({
          scope: 'reset_token',
          limit: 5,
          windowMs: 900000,
        }),
      ]),
    );
  });

  it('checks reset expiry again after hashing the new password', async () => {
    const { recovery, state, clock, hasher, passwordResetTokenIssuer } =
      localAuth();
    seedActiveAccount(state);
    await recovery.forgotPassword({ email: EMAIL }, '203.0.113.7');

    const token = issuedToken(passwordResetTokenIssuer.issued);
    const expiresAt = passwordResetTokenIssuer.issued[0]?.expiresAt;
    const account = state.accounts.get(USER_ID);
    if (expiresAt === undefined || account === undefined) {
      throw new Error('the account and reset token were not seeded');
    }
    const originalPasswordHash = account.passwordHash;
    const hashPassword = hasher.hash.bind(hasher);
    jest.spyOn(hasher, 'hash').mockImplementation(async (password) => {
      clock.value = new Date(expiresAt.getTime() + 1);
      return hashPassword(password);
    });

    await expect(
      recovery.resetPassword(
        { token, password: 'new password that works' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
      httpStatus: 400,
    });
    expect(account.passwordHash).toBe(originalPasswordHash);
  });
});
