import { seedAccount } from '@/modules/auth/testing/in-memory-auth.state';
import {
  EMAIL,
  LEGACY_PASSWORD_HASH,
  NOW,
  type SeededAccount,
  USER_ID,
  localAuth,
  seedActiveAccount,
  sessionOf,
  setStatus,
} from '@/modules/auth/testing/local-auth.service.spec-support';

describe('LocalSessionService', () => {
  it('issues an access token only for an active account and does not count success', async () => {
    const { sessions, state, limiter, hasher } = localAuth();
    seedActiveAccount(state);

    await expect(
      sessions.login(
        { email: ' Person@Example.com ', password: '  exact password  ' },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      kind: 'session',
      session: {
        accessToken: `jwt-for-${USER_ID}`,
        expiresIn: 900,
        refreshToken: 'refresh-1',
      },
    });
    expect(hasher.verified).toEqual(['  exact password  ']);
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'login_ip' }),
        expect.objectContaining({ scope: 'login_email' }),
      ]),
    );
  });

  it('upgrades a legacy password hash after successful login before creating the session', async () => {
    const { sessions, state } = localAuth();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);

    await expect(
      sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      'argon2:correct horse battery',
    );
    expect(state.refreshTokens.size).toBe(1);
  });

  it('does not rewrite a legacy hash for an incorrect password', async () => {
    const { sessions, state, hasher } = localAuth();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    hasher.result = false;

    await expect(
      sessions.login(
        { email: EMAIL, password: 'wrong password' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(state.refreshTokens.size).toBe(0);
    expect(hasher.hashed).toEqual([]);
  });

  it('does not overwrite a password reset that wins before the hash upgrade', async () => {
    const { sessions, state, hasher } = localAuth();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    const account = state.accounts.get(USER_ID);
    if (account === undefined) throw new Error('the account was not seeded');
    jest.spyOn(hasher, 'needsRehash').mockImplementation(() => {
      account.passwordHash = 'argon2:reset password';
      return true;
    });

    await expect(
      sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });

    expect(account.passwordHash).toBe('argon2:reset password');
    expect(state.refreshTokens.size).toBe(0);
  });

  it('creates no session when saving a replacement password hash fails', async () => {
    const { sessions, state, userAccounts } = localAuth();
    seedActiveAccount(state, LEGACY_PASSWORD_HASH);
    const update = jest
      .spyOn(userAccounts, 'updatePasswordHash')
      .mockRejectedValue(new Error('storage unavailable'));

    await expect(
      sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).rejects.toThrow('storage unavailable');

    expect(state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(state.refreshTokens.size).toBe(0);
    update.mockRestore();
  });

  it('requires an MFA proof before writing a session and counts invalid proof generically', async () => {
    const required = localAuth();
    seedActiveAccount(required.state, LEGACY_PASSWORD_HASH);
    required.state.mfaFactors.set(USER_ID, {
      factorId: 'mfa_01J00000000000000000000000',
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    required.mfa.result = { kind: 'required' };

    await expect(
      required.sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    ).resolves.toEqual({ kind: 'mfa-required' });
    expect(required.state.refreshTokens.size).toBe(0);
    expect(required.state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );

    required.mfa.result = { kind: 'invalid' };
    await expect(
      required.sessions.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'bad' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_CREDENTIALS_INVALID',
      httpStatus: 401,
    });
    expect(required.state.accounts.get(USER_ID)?.passwordHash).toBe(
      LEGACY_PASSWORD_HASH,
    );
    expect(required.limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'login_ip' }),
        expect.objectContaining({ scope: 'login_email' }),
      ]),
    );
  });

  it('consumes a recovery code only in the same write that creates its session', async () => {
    const context = localAuth();
    seedActiveAccount(context.state);
    const factorId = 'mfa_01J00000000000000000000000';
    const codeHash = 'a'.repeat(64);
    context.state.mfaFactors.set(USER_ID, {
      factorId,
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    context.state.recoveryCodes.set(USER_ID, new Set([codeHash]));
    context.mfa.result = {
      kind: 'proved',
      proof: { kind: 'recovery', codeHash },
    };

    await expect(
      context.sessions.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'ABCD' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(context.state.recoveryCodes.get(USER_ID)?.has(codeHash)).toBe(false);
    expect(context.state.refreshTokens.size).toBe(1);

    await expect(
      context.sessions.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: 'ABCD' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
    expect(context.state.refreshTokens.size).toBe(1);
  });

  it('accepts a TOTP proof only for the matching active factor', async () => {
    const context = localAuth();
    seedActiveAccount(context.state);
    const factorId = 'mfa_01J00000000000000000000000';
    context.state.mfaFactors.set(USER_ID, {
      factorId,
      status: 'enabled',
      email: EMAIL,
      secret: 'encrypted',
    });
    context.mfa.result = {
      kind: 'proved',
      proof: { kind: 'totp', factorId },
    };

    await expect(
      context.sessions.login(
        { email: EMAIL, password: 'correct horse battery', mfa_code: '123456' },
        '203.0.113.7',
      ),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(context.state.refreshTokens.size).toBe(1);
  });

  it.each<[string, SeededAccount | undefined]>([
    ['unknown email', undefined],
    [
      'pending account',
      { userId: 'usr_pending', status: 'pending_verification' },
    ],
    ['disabled account', { userId: 'usr_disabled', status: 'disabled' }],
  ])('returns one generic credential error for %s', async (_label, seeded) => {
    const { sessions, state, limiter, hasher } = localAuth();
    if (seeded !== undefined) {
      seedAccount(state, {
        userId: seeded.userId,
        email: EMAIL,
        username: 'person_01',
        passwordHash: 'hash',
        status: seeded.status,
      });
    }
    hasher.result = false;

    await expect(
      sessions.login(
        { email: EMAIL, password: 'wrong password' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_CREDENTIALS_INVALID',
      httpStatus: 401,
    });
    expect(hasher.verified).toHaveLength(1);
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'login_ip',
          limit: 20,
          windowMs: 300000,
        }),
        expect.objectContaining({
          scope: 'login_email',
          limit: 5,
          windowMs: 900000,
        }),
      ]),
    );
  });

  it('returns a rate-limit error after a failed credential attempt when the limiter denies it', async () => {
    const { sessions, state, limiter, hasher } = localAuth();
    seedActiveAccount(state);
    limiter.allowed = false;
    hasher.result = false;

    await expect(
      sessions.login(
        { email: EMAIL, password: 'wrong password' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });

  it('rotates a valid refresh credential and does not count successful refreshes', async () => {
    const { sessions, state, limiter } = localAuth();
    seedActiveAccount(state);
    const login = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );

    await expect(
      sessions.refresh(login.refreshToken, '203.0.113.7'),
    ).resolves.toEqual({
      accessToken: `jwt-for-${USER_ID}`,
      expiresIn: 900,
      refreshToken: 'refresh-2',
    });
    expect(state.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: NOW,
    });
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    const { sessions, state } = localAuth();
    seedActiveAccount(state);
    const login = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    const rotated = await sessions.refresh(login.refreshToken, '203.0.113.7');

    await expect(
      sessions.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_INVALID' });
    expect(state.refreshTokens.get('hash:refresh-2')?.revokedAt).toEqual(NOW);
    await expect(
      sessions.refresh(rotated.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_INVALID' });
  });

  it('logs out idempotently and leaves another login usable', async () => {
    const { sessions, state } = localAuth();
    seedActiveAccount(state);
    const first = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    const second = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );

    await expect(sessions.logout(first.refreshToken)).resolves.toBeUndefined();
    await expect(sessions.logout(first.refreshToken)).resolves.toBeUndefined();
    expect(state.refreshTokens.get('hash:refresh-1')?.revokedAt).toEqual(NOW);
    await expect(
      sessions.refresh(second.refreshToken, '203.0.113.7'),
    ).resolves.toMatchObject({ accessToken: `jwt-for-${USER_ID}` });
  });

  it('uses only the IP failure limit when the cookie is missing', async () => {
    const { sessions, limiter } = localAuth();

    await expect(
      sessions.refresh(undefined, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(limiter.calls).toEqual([
      expect.objectContaining({
        scope: 'refresh_ip',
        limit: 20,
        windowMs: 300000,
      }),
    ]);
  });

  it('uses the strict expiry boundary and leaves the family available for audit', async () => {
    const { sessions, state, clock } = localAuth();
    seedActiveAccount(state);
    const login = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    clock.value = new Date('2026-10-20T00:00:00.000Z');

    await expect(
      sessions.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(state.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: undefined,
      revokedAt: undefined,
    });
  });

  it('rejects disabled accounts without consuming a failure limit for infrastructure errors', async () => {
    const { sessions, state, limiter } = localAuth();
    seedActiveAccount(state);
    const login = sessionOf(
      await sessions.login(
        { email: EMAIL, password: 'correct horse battery' },
        '203.0.113.7',
      ),
    );
    setStatus(state, 'disabled');

    await expect(
      sessions.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );

    const unavailable = localAuth();
    unavailable.refreshSessions.failFindRefreshToken = true;
    await expect(
      unavailable.sessions.refresh('refresh-unknown', '203.0.113.7'),
    ).rejects.toThrow('durable store unavailable');
    expect(unavailable.limiter.calls).toHaveLength(0);
  });
});
