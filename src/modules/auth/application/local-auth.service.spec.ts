import type { LocalAccountStatus } from '../domain/local-auth';
import type { AuthRateLimiterPort } from './auth-rate-limiter.port';
import type {
  EmailSenderPort,
  PasswordResetEmailInput,
  VerificationEmailInput,
} from './email-sender.port';
import type {
  LocalAuthRepositoryPort,
  LoginIdentity,
  PasswordResetResult,
  PasswordResetTarget,
  RefreshTokenRecord,
  ResendVerificationTarget,
} from './local-auth-repository.port';
import { LocalAuthService } from './local-auth.service';
import type { PasswordHasherPort } from './password-hasher.port';
import type {
  IssuedPasswordResetToken,
  PasswordResetTokenPort,
} from './password-reset-token.port';
import type {
  IssuedRefreshToken,
  RefreshTokenIssuerPort,
} from './refresh-token.port';
import type {
  IssuedUserAccessToken,
  UserAccessTokenIssuerPort,
} from './user-access-token.port';
import type {
  IssuedVerificationToken,
  VerificationTokenPort,
} from './verification-token.port';

class FakeRepository implements LocalAuthRepositoryPort {
  registered: unknown[] = [];
  resendTarget: ResendVerificationTarget | undefined = {
    email: 'person@example.com',
  };
  consumed = true;
  loginIdentity: LoginIdentity | undefined = {
    userId: 'usr_01J00000000000000000000000',
    passwordHash: 'argon2:correct horse battery',
    status: 'active' as const,
  };
  statusByUserId = new Map<string, LocalAccountStatus>([
    ['usr_01J00000000000000000000000', 'active' as const],
  ]);
  refreshTokens = new Map<string, RefreshTokenRecord>();
  refreshLookupFailure = false;
  passwordResetTarget: PasswordResetTarget | undefined = {
    userId: 'usr_01J00000000000000000000000',
    email: 'person@example.com',
  };
  passwordResetResult: PasswordResetResult = {
    kind: 'reset',
    userId: 'usr_01J00000000000000000000000',
  };
  passwordResetInputs: unknown[] = [];

  async register(input: unknown): Promise<void> {
    this.registered.push(input);
  }

  async rotateVerificationToken(): Promise<
    ResendVerificationTarget | undefined
  > {
    return this.resendTarget;
  }

  async consumeVerificationToken(): Promise<boolean> {
    return this.consumed;
  }

  async issuePasswordResetToken(): Promise<PasswordResetTarget | undefined> {
    return this.passwordResetTarget;
  }

  async consumePasswordReset(input: unknown): Promise<PasswordResetResult> {
    this.passwordResetInputs.push(input);
    return this.passwordResetResult;
  }

  async findLoginIdentityByEmail() {
    return this.loginIdentity;
  }

  async findUserAccountStatus(userId: string) {
    return this.statusByUserId.get(userId);
  }

  async createRefreshSession(input: {
    readonly userId: string;
    readonly token: IssuedRefreshToken;
    readonly issuedAt: Date;
  }): Promise<void> {
    this.refreshTokens.set(input.token.hash, {
      tokenId: input.token.id,
      familyId: input.token.familyId,
      userId: input.userId,
      expiresAt: input.token.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
  }

  async findRefreshTokenByHash(tokenHash: string) {
    if (this.refreshLookupFailure) {
      throw new Error('durable store unavailable');
    }
    return this.refreshTokens.get(tokenHash);
  }

  async rotateRefreshToken(input: {
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly successor: IssuedRefreshToken;
    readonly now: Date;
  }) {
    const current = this.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return { kind: 'invalid' as const, reason: 'missing' as const };
    }
    if (this.statusByUserId.get(current.userId) !== 'active') {
      return { kind: 'invalid' as const, reason: 'inactive' as const };
    }
    if (current.usedAt !== undefined) {
      return { kind: 'invalid' as const, reason: 'used' as const };
    }
    if (current.revokedAt !== undefined) {
      return { kind: 'invalid' as const, reason: 'revoked' as const };
    }
    if (current.expiresAt <= input.now) {
      return { kind: 'invalid' as const, reason: 'expired' as const };
    }
    this.refreshTokens.set(input.tokenHash, { ...current, usedAt: input.now });
    this.refreshTokens.set(input.successor.hash, {
      tokenId: input.successor.id,
      familyId: input.successor.familyId,
      userId: current.userId,
      expiresAt: input.successor.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
    return { kind: 'rotated' as const, userId: current.userId };
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    const current = this.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return;
    }
    for (const [hash, token] of this.refreshTokens) {
      if (token.familyId === current.familyId) {
        this.refreshTokens.set(hash, { ...token, revokedAt: input.now });
      }
    }
  }
}

class FakeHasher implements PasswordHasherPort {
  verified: string[] = [];
  result = true;

  async hash(password: string): Promise<string> {
    return `argon2:${password}`;
  }

  async verify(password: string): Promise<boolean> {
    this.verified.push(password);
    return this.result;
  }
}

class FakeTokenIssuer implements VerificationTokenPort {
  issue(now: Date): IssuedVerificationToken {
    return {
      id: 'evt_01J00000000000000000000000',
      raw: 'opaque-token',
      hash: 'hash-token',
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class FakePasswordResetTokenIssuer implements PasswordResetTokenPort {
  issue(now: Date): IssuedPasswordResetToken {
    return {
      id: 'prt_01J00000000000000000000000',
      raw: 'reset-token',
      hash: 'reset-hash',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    };
  }

  hash(raw: string): string {
    return `reset-hash:${raw}`;
  }
}

class FakeSender implements EmailSenderPort {
  sent: VerificationEmailInput[] = [];
  resetSent: PasswordResetEmailInput[] = [];
  fail = false;

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    if (this.fail) {
      throw new Error('provider failure');
    }
    this.sent.push(input);
  }

  async sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    if (this.fail) {
      throw new Error('provider failure');
    }
    this.resetSent.push(input);
  }
}

class FakeAccessTokenIssuer implements UserAccessTokenIssuerPort {
  async issue(userId: string): Promise<IssuedUserAccessToken> {
    return {
      token: `jwt-for-${userId}`,
      expiresIn: 900,
    };
  }
}

class FakeRefreshTokenIssuer implements RefreshTokenIssuerPort {
  sequence = 0;

  issue(now: Date, familyId?: string): IssuedRefreshToken {
    this.sequence += 1;
    const raw = `refresh-${this.sequence}`;
    return {
      id: `rft_${this.sequence}`,
      familyId: familyId ?? `rfs_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class FakeLimiter implements AuthRateLimiterPort {
  calls: unknown[] = [];
  allowed = true;

  async consume(input: Parameters<AuthRateLimiterPort['consume']>[0]) {
    this.calls.push(input);
    return { allowed: this.allowed, retryAfterMs: 1000 };
  }
}

class FakeClock {
  value = new Date('2026-09-20T00:00:00.000Z');

  now(): Date {
    return new Date(this.value);
  }
}

function service() {
  const repository = new FakeRepository();
  const sender = new FakeSender();
  const limiter = new FakeLimiter();
  const hasher = new FakeHasher();
  const refreshTokenIssuer = new FakeRefreshTokenIssuer();
  const clock = new FakeClock();
  const local = new LocalAuthService(
    repository,
    hasher,
    new FakeTokenIssuer(),
    new FakePasswordResetTokenIssuer(),
    sender,
    limiter,
    new FakeAccessTokenIssuer(),
    refreshTokenIssuer,
    clock,
  );
  return {
    local,
    repository,
    sender,
    limiter,
    hasher,
    refreshTokenIssuer,
    clock,
  };
}

describe('LocalAuthService', () => {
  it('registers a canonical pending account and sends only the opaque token', async () => {
    const { local, repository, sender, limiter } = service();

    await expect(
      local.register(
        {
          email: ' Person@Example.com ',
          username: ' Person_01 ',
          password: '  exact password  ',
        },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      email: 'person@example.com',
      username: 'person_01',
      status: 'pending_verification',
    });
    expect(repository.registered[0]).toMatchObject({
      email: 'person@example.com',
      username: 'person_01',
      passwordHash: 'argon2:  exact password  ',
      tokenHash: 'hash-token',
    });
    expect(sender.sent[0]).toMatchObject({
      email: 'person@example.com',
      token: 'opaque-token',
    });
    expect(limiter.calls).toHaveLength(2);
  });

  it('returns a generic resend result for unknown addresses', async () => {
    const { local, repository, sender } = service();
    repository.resendTarget = undefined;

    await expect(
      local.resend('nobody@example.com', '203.0.113.7'),
    ).resolves.toBe(undefined);
    expect(sender.sent).toHaveLength(0);
  });

  it('returns one recovery message, sends only for an active target, and swallows provider failure', async () => {
    const { local, repository, sender, limiter } = service();
    sender.fail = true;

    await expect(
      local.forgotPassword({ email: ' Person@Example.com ' }, '203.0.113.7'),
    ).resolves.toEqual({
      message: 'If the account exists, reset instructions have been sent.',
    });
    expect(repository.passwordResetTarget).toBeDefined();
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'forgot_ip',
          limit: 3,
          windowMs: 900000,
        }),
        expect.objectContaining({
          scope: 'forgot_email',
          limit: 3,
          windowMs: 86400000,
        }),
      ]),
    );

    repository.passwordResetTarget = undefined;
    await expect(
      local.forgotPassword({ email: 'nobody@example.com' }, '203.0.113.7'),
    ).resolves.toEqual({
      message: 'If the account exists, reset instructions have been sent.',
    });
  });

  it('maps every unusable reset token to one public error and counts only failures', async () => {
    const { local, repository, limiter } = service();
    repository.passwordResetResult = { kind: 'invalid', reason: 'consumed' };

    await expect(
      local.resetPassword(
        { token: 'reset-token', password: 'new password that works' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
      httpStatus: 400,
    });
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

    const successful = service();
    await expect(
      successful.local.resetPassword(
        { token: 'reset-token', password: 'new password that works' },
        '203.0.113.7',
      ),
    ).resolves.toBeUndefined();
    expect(successful.limiter.calls).toHaveLength(0);
  });

  it('maps provider failure on registration without rolling back persistence', async () => {
    const { local, sender, repository } = service();
    sender.fail = true;

    await expect(
      local.register(
        {
          email: 'person@example.com',
          username: 'person_01',
          password: 'correct horse battery',
        },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE' });
    expect(repository.registered).toHaveLength(1);
  });

  it('uses one generic invalid result for replay/expiry/unknown verification tokens', async () => {
    const { local, repository } = service();
    repository.consumed = false;

    await expect(
      local.verify('bad-token', '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_VERIFICATION_TOKEN_INVALID',
    });
  });

  it('issues an access token only for an active account and does not count success', async () => {
    const { local, limiter, hasher } = service();

    await expect(
      local.login(
        { email: ' Person@Example.com ', password: '  exact password  ' },
        '203.0.113.7',
      ),
    ).resolves.toEqual({
      accessToken: 'jwt-for-usr_01J00000000000000000000000',
      expiresIn: 900,
      refreshToken: 'refresh-1',
    });
    expect(hasher.verified).toEqual(['  exact password  ']);
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'login_ip' }),
        expect.objectContaining({ scope: 'login_email' }),
      ]),
    );
  });

  it.each([
    ['unknown email', undefined],
    [
      'pending account',
      {
        userId: 'usr_pending',
        passwordHash: 'hash',
        status: 'pending_verification' as const,
      },
    ],
    [
      'disabled account',
      {
        userId: 'usr_disabled',
        passwordHash: 'hash',
        status: 'disabled' as const,
      },
    ],
  ])(
    'returns one generic credential error for %s',
    async (_label, identity) => {
      const { local, repository, limiter, hasher } = service();
      repository.loginIdentity = identity;
      hasher.result = false;

      await expect(
        local.login(
          { email: 'person@example.com', password: 'wrong password' },
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
    },
  );

  it('returns a rate-limit error after a failed credential attempt when the limiter denies it', async () => {
    const { local, limiter, hasher } = service();
    limiter.allowed = false;
    hasher.result = false;

    await expect(
      local.login(
        { email: 'person@example.com', password: 'wrong password' },
        '203.0.113.7',
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
  });

  it('rotates a valid refresh credential and does not count successful refreshes', async () => {
    const { local, repository, limiter } = service();
    const login = await local.login(
      { email: 'person@example.com', password: 'correct horse battery' },
      '203.0.113.7',
    );

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).resolves.toEqual({
      accessToken: 'jwt-for-usr_01J00000000000000000000000',
      expiresIn: 900,
      refreshToken: 'refresh-2',
    });
    expect(repository.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    expect(limiter.calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );
  });

  it('uses only the IP failure limit when the cookie is missing', async () => {
    const { local, limiter } = service();

    await expect(local.refresh(undefined, '203.0.113.7')).rejects.toMatchObject(
      {
        code: 'AUTH_REFRESH_TOKEN_INVALID',
      },
    );
    expect(limiter.calls).toEqual([
      expect.objectContaining({
        scope: 'refresh_ip',
        limit: 20,
        windowMs: 300000,
      }),
    ]);
  });

  it('uses the strict expiry boundary and leaves the family available for audit', async () => {
    const { local, repository, clock } = service();
    const login = await local.login(
      { email: 'person@example.com', password: 'correct horse battery' },
      '203.0.113.7',
    );
    clock.value = new Date('2026-10-20T00:00:00.000Z');

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(repository.refreshTokens.get('hash:refresh-1')).toMatchObject({
      usedAt: undefined,
      revokedAt: undefined,
    });
  });

  it('rejects disabled accounts without consuming a failure limit for infrastructure errors', async () => {
    const { local, repository, limiter } = service();
    const login = await local.login(
      { email: 'person@example.com', password: 'correct horse battery' },
      '203.0.113.7',
    );
    repository.statusByUserId.set('usr_01J00000000000000000000000', 'disabled');

    await expect(
      local.refresh(login.refreshToken, '203.0.113.7'),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });
    expect(limiter.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'refresh_ip' }),
        expect.objectContaining({ scope: 'refresh_token' }),
      ]),
    );

    const unavailable = service();
    unavailable.repository.refreshLookupFailure = true;
    await expect(
      unavailable.local.refresh('refresh-unknown', '203.0.113.7'),
    ).rejects.toThrow('durable store unavailable');
    expect(unavailable.limiter.calls).toHaveLength(0);
  });
});
