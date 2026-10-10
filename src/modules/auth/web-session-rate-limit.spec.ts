import { AppModule } from '@/app.module';
import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';
import { AUTH_MFA_REPOSITORY } from './application/auth-mfa-repository.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './application/auth-rate-limiter.port';
import { AUTH_CLOCK } from './application/local-auth.service';
import { PASSWORD_HASHER } from './application/password-hasher.port';
import { USER_ACCOUNT_REPOSITORY } from './application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from './application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from './application/verification-token.port';
import { WEB_SESSION_CLIENT_SECRET } from './application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from './application/web-session-repository.port';
import {
  type AuthRedisClient,
  RedisAuthRateLimiter,
} from './infrastructure/redis-auth-rate-limiter';
import { InMemoryAuthMfaAdapter } from './testing/in-memory-auth-mfa.adapter';
import {
  createInMemoryAuthState,
  seedAccount,
} from './testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from './testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from './testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from './testing/in-memory-web-session.adapter';

const BASE = '/v1/auth/web-sessions';
const SECRET = 'fake-bff-secret';
const USER_ID = 'usr_01J00000000000000000000000';
const BINDING = 'b'.repeat(43);
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const NOW = Date.parse('2026-10-08T00:00:00.000Z');
const redisUnavailable: AuthRedisClient = {
  eval: async () => {
    throw new Error('Redis unavailable');
  },
  on: () => undefined,
  disconnect: () => undefined,
};

describe('Web Session HTTP rate limits with Redis unavailable', () => {
  let app: NestFastifyApplication;
  let now = NOW;
  let limiter: RedisAuthRateLimiter;
  let tokens: VerificationTokenPort;
  const state = createInMemoryAuthState();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(state))
      .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
      .useValue(new InMemoryVerificationTokenAdapter(state))
      .overrideProvider(WEB_SESSION_REPOSITORY)
      .useValue(new InMemoryWebSessionAdapter(state))
      .overrideProvider(AUTH_MFA_REPOSITORY)
      .useValue(new InMemoryAuthMfaAdapter(state))
      .overrideProvider(WEB_SESSION_CLIENT_SECRET)
      .useValue({ resolve: () => SECRET })
      .overrideProvider(PASSWORD_HASHER)
      .useValue({
        hash: async () => '$argon2id$fake',
        verify: async (password: string) => password === PASSWORD,
      })
      .overrideProvider(AUTH_CLOCK)
      .useValue({ now: () => new Date(now) })
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue({
        consume: (input: Parameters<AuthRateLimiterPort['consume']>[0]) =>
          limiter.consume(input),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    const fastify = app.getHttpAdapter().getInstance();
    await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
    await app.init();
    await fastify.ready();
    tokens = app.get<VerificationTokenPort>(VERIFICATION_TOKEN);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    now = NOW;
    state.reset();
    limiter = new RedisAuthRateLimiter('', () => now, redisUnavailable);
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: '$argon2id$fake',
    });
  });

  function request(path: string, payload: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: path,
      headers: { 'x-aihub-client-secret': SECRET },
      payload,
    });
  }

  function verificationToken(index: number): string {
    const userId = `usr_${String(index).padStart(26, '0')}`;
    seedAccount(state, {
      userId,
      email: `user${index}@example.com`,
      passwordHash: '$argon2id$fake',
      status: 'pending_verification',
    });
    const token = tokens.issue(new Date(now));
    state.verificationTokens.set(token.hash, {
      tokenId: token.id,
      userId,
      expiresAt: token.expiresAt,
      browserBindingHash: tokens.hash(BINDING),
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    return token.raw;
  }

  it('keeps login protection and recovery available through the local fallback', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await request(BASE, { email: EMAIL, password: 'a wrong password' }))
          .statusCode,
      ).toBe(401);
    }
    const blocked = await request(BASE, {
      email: EMAIL,
      password: 'a wrong password',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(blocked.json().error.retry_after_ms).toBe(15 * 60_000);
    expect(state.webSessions.size).toBe(0);
    expect(
      (await request(BASE, { email: EMAIL, password: PASSWORD })).statusCode,
    ).toBe(201);
    now += 15 * 60_000;
    expect(
      (await request(BASE, { email: EMAIL, password: 'a wrong password' }))
        .statusCode,
    ).toBe(401);
  });

  it('bounds failed exchanges while repeated successful exchanges consume no budget', async () => {
    const created = await request(BASE, { email: EMAIL, password: PASSWORD });
    const body: unknown = created.json();
    if (!Value.Check(CreateWebSessionResponseSchema, body))
      throw new Error('session not created');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        (
          await request(`${BASE}/exchange`, {
            web_session_token: body.data.web_session_token,
          })
        ).statusCode,
      ).toBe(200);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await request(`${BASE}/exchange`, {
            web_session_token: 'unknown-session',
          })
        ).statusCode,
      ).toBe(401);
    }
    const blocked = await request(`${BASE}/exchange`, {
      web_session_token: 'unknown-session',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(blocked.payload).not.toContain('access_token');
    expect(
      (
        await request(`${BASE}/exchange`, {
          web_session_token: body.data.web_session_token,
        })
      ).statusCode,
    ).toBe(200);
    now += 15 * 60_000;
    expect(
      (
        await request(`${BASE}/exchange`, {
          web_session_token: 'unknown-session',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('allows more than ten independent BFF confirmations behind one proxy', async () => {
    for (let index = 1; index <= 12; index += 1) {
      const response = await request(`${BASE}/verification`, {
        token: verificationToken(index),
        browser_binding: BINDING,
      });
      expect(response.statusCode).toBe(201);
    }
    expect(state.webSessions.size).toBe(12);
  });

  it('isolates BFF token budgets from each other and from browser verification', async () => {
    const token = verificationToken(1);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (
          await request(`${BASE}/verification`, {
            token: 'unknown-verification-token',
          })
        ).statusCode,
      ).toBe(400);
    }
    const blocked = await request(`${BASE}/verification`, {
      token: 'unknown-verification-token',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(blocked.payload).not.toContain('web_session_token');
    expect(
      (
        await request('/v1/auth/verify-email', {
          token,
          browser_binding: BINDING,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(`${BASE}/verification`, {
          token: verificationToken(2),
          browser_binding: BINDING,
        })
      ).statusCode,
    ).toBe(201);
    now += 5 * 60_000;
    expect(
      (
        await request(`${BASE}/verification`, {
          token: 'unknown-verification-token',
        })
      ).statusCode,
    ).toBe(400);
  });
});
