import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { generateRequestId } from '../../../common/request-context/request-id';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '../application/auth-rate-limiter.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '../application/email-sender.port';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../application/local-auth-repository.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../application/password-hasher.port';
import {
  type IssuedVerificationToken,
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '../application/verification-token.port';

class RepositoryFake implements LocalAuthRepositoryPort {
  consumed = true;
  target = { email: 'person@example.com' };
  registered = 0;

  async register(): Promise<void> {
    this.registered += 1;
  }

  async rotateVerificationToken() {
    return this.target;
  }

  async consumeVerificationToken(): Promise<boolean> {
    return this.consumed;
  }
}

class SenderFake implements EmailSenderPort {
  fail = false;

  async sendVerificationEmail(): Promise<void> {
    if (this.fail) {
      throw new Error('provider failed');
    }
  }
}

class HasherFake implements PasswordHasherPort {
  async hash(): Promise<string> {
    return '$argon2id$fake';
  }

  async verify(): Promise<boolean> {
    return true;
  }
}

class TokenFake implements VerificationTokenPort {
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

class LimiterFake implements AuthRateLimiterPort {
  async consume(): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }
}

describe('local auth HTTP boundary', () => {
  let app: NestFastifyApplication;
  let repository: RepositoryFake;
  let sender: SenderFake;

  beforeAll(async () => {
    repository = new RepositoryFake();
    sender = new SenderFake();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(repository)
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
      .overrideProvider(PASSWORD_HASHER)
      .useClass(HasherFake)
      .overrideProvider(VERIFICATION_TOKEN)
      .useClass(TokenFake)
      .overrideProvider(AUTH_RATE_LIMITER)
      .useClass(LimiterFake)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers with a safe projection and verifies through the real HTTP stack', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ' Person@Example.com ',
        username: ' Person_01 ',
        password: 'correct horse battery',
      },
    });

    expect(register.statusCode).toBe(201);
    expect(register.json()).toEqual({
      data: {
        email: 'person@example.com',
        username: 'person_01',
        status: 'pending_verification',
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    expect(register.payload).not.toContain('argon2');

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'opaque-token' },
    });
    expect(verify.statusCode).toBe(204);
    expect(verify.payload).toBe('');
  });

  it('keeps malformed input generic and provider failures non-sensitive', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatchObject({ code: 'INVALID_REQUEST' });

    sender.fail = true;
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'second@example.com',
        username: 'second_01',
        password: 'correct horse battery',
      },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE' }),
    );
    expect(failed.payload).not.toContain('provider failed');
  });

  it('returns a bodyless generic 202 for resend', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.payload).toBe('');
  });
});
