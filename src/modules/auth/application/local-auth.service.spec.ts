import type { AuthRateLimiterPort } from './auth-rate-limiter.port';
import type {
  EmailSenderPort,
  VerificationEmailInput,
} from './email-sender.port';
import type {
  LocalAuthRepositoryPort,
  ResendVerificationTarget,
} from './local-auth-repository.port';
import { LocalAuthService } from './local-auth.service';
import type { PasswordHasherPort } from './password-hasher.port';
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
}

class FakeHasher implements PasswordHasherPort {
  async hash(password: string): Promise<string> {
    return `argon2:${password}`;
  }

  async verify(): Promise<boolean> {
    return true;
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
  const local = new LocalAuthService(
    repository,
    new FakeHasher(),
    new FakeTokenIssuer(),
    sender,
    limiter,
  );
  return { local, repository, sender, limiter };
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
});
