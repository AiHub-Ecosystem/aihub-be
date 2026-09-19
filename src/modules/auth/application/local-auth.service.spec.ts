import type { AuthRateLimiterPort } from './auth-rate-limiter.port';
import type {
  EmailSenderPort,
  VerificationEmailInput,
} from './email-sender.port';
import type {
  LocalAuthRepositoryPort,
  LoginIdentity,
  ResendVerificationTarget,
} from './local-auth-repository.port';
import { LocalAuthService } from './local-auth.service';
import type { PasswordHasherPort } from './password-hasher.port';
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
  statusByUserId = new Map([
    ['usr_01J00000000000000000000000', 'active' as const],
  ]);

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

  async findLoginIdentityByEmail() {
    return this.loginIdentity;
  }

  async findUserAccountStatus(userId: string) {
    return this.statusByUserId.get(userId);
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

class FakeSender implements EmailSenderPort {
  sent: VerificationEmailInput[] = [];
  fail = false;

  async sendVerificationEmail(input: VerificationEmailInput): Promise<void> {
    if (this.fail) {
      throw new Error('provider failure');
    }
    this.sent.push(input);
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

class FakeLimiter implements AuthRateLimiterPort {
  calls: unknown[] = [];
  allowed = true;

  async consume(input: Parameters<AuthRateLimiterPort['consume']>[0]) {
    this.calls.push(input);
    return { allowed: this.allowed, retryAfterMs: 1000 };
  }
}

function service() {
  const repository = new FakeRepository();
  const sender = new FakeSender();
  const limiter = new FakeLimiter();
  const hasher = new FakeHasher();
  const local = new LocalAuthService(
    repository,
    hasher,
    new FakeTokenIssuer(),
    sender,
    limiter,
    new FakeAccessTokenIssuer(),
  );
  return { local, repository, sender, limiter, hasher };
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
});
