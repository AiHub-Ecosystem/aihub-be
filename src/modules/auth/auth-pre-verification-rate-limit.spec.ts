import { AppModule } from '@/app.module';
import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { USER_ACCOUNT_REPOSITORY } from './accounts/application/user-account.port';
import { AUTH_CLOCK } from './local-credentials/application/local-auth.service';
import { PASSWORD_HASHER } from './local-credentials/application/password-hasher.port';
import {
  AUTH_MFA_CIPHER,
  AUTH_MFA_REPOSITORY,
} from './mfa/application/auth-mfa-repository.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './rate-limit/application/auth-rate-limiter.port';
import {
  type AuthRedisClient,
  RedisAuthRateLimiter,
} from './rate-limit/infrastructure/redis-auth-rate-limiter';
import { InMemoryAuthMfaAdapter } from './testing/in-memory-auth-mfa.adapter';
import {
  createInMemoryAuthState,
  seedAccount,
} from './testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from './testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from './testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from './testing/in-memory-web-session.adapter';
import { VERIFICATION_TOKEN_REPOSITORY } from './verification/application/verification-token-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from './web-sessions/application/user-access-token.port';
import { WEB_SESSION_CLIENT_SECRET } from './web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from './web-sessions/application/web-session-repository.port';

const LOGIN = '/v1/auth/login';
const MFA_BEGIN = '/v1/auth/mfa/enrollment';
const MFA_CONFIRM = '/v1/auth/mfa/enrollment/confirm';
const MFA_REMOVE = '/v1/auth/mfa';
const SECRET = 'test-bff-secret';
const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const TOKEN = 'header.payload.signature';
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const TOTP_CODE = '287082';
const FACTOR_ID = 'mfa_01J00000000000000000000000';
const NOW = 59_000;
const END_USER_IP = '198.51.100.10';
const OTHER_END_USER_IP = '198.51.100.20';

const redisUnavailable: AuthRedisClient = {
  eval: async () => {
    throw new Error('Redis unavailable');
  },
  on: () => undefined,
  disconnect: () => undefined,
};

describe('auth pre-verification rate limits over HTTP with Redis unavailable', () => {
  let app: NestFastifyApplication;
  let limiter: RedisAuthRateLimiter;
  let now = NOW;
  let verifyPassword: jest.Mock<Promise<boolean>, [string, string]>;
  let decryptMfaSecret: jest.Mock<
    string,
    [string, string, { readonly userId: string; readonly factorId: string }]
  >;
  const state = createInMemoryAuthState();

  beforeAll(async () => {
    verifyPassword = jest.fn(
      async (password: string, _passwordHash: string) => password === PASSWORD,
    );
    decryptMfaSecret = jest.fn(
      (_keyId: string, ciphertext: string, _binding) => ciphertext,
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(state))
      .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
      .useValue(new InMemoryVerificationTokenAdapter(state))
      .overrideProvider(WEB_SESSION_REPOSITORY)
      .useValue(new InMemoryWebSessionAdapter(state))
      .overrideProvider(AUTH_MFA_REPOSITORY)
      .useValue(new InMemoryAuthMfaAdapter(state))
      .overrideProvider(AUTH_MFA_CIPHER)
      .useValue({
        encrypt: (plaintext: string) => ({
          keyId: 'memory',
          ciphertext: plaintext,
        }),
        decrypt: decryptMfaSecret,
      })
      .overrideProvider(WEB_SESSION_CLIENT_SECRET)
      .useValue({ resolve: () => SECRET })
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue({
        verify: async (): ReturnType<
          UserAccessTokenVerifierPort['verify']
        > => ({ userId: USER_ID, jti: 'test-token' }),
      })
      .overrideProvider(PASSWORD_HASHER)
      .useValue({
        hash: async () => '$argon2id$fake',
        verify: verifyPassword,
      })
      .overrideProvider(AUTH_CLOCK)
      .useValue({ now: () => new Date(now) })
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue({
        check: (input: Parameters<AuthRateLimiterPort['check']>[0]) =>
          limiter.check(input),
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    now = NOW;
    state.reset();
    limiter = new RedisAuthRateLimiter('', () => now, redisUnavailable);
    verifyPassword.mockClear();
    decryptMfaSecret.mockClear();
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: '$argon2id$fake',
    });
  });

  function login(email = EMAIL, password = PASSWORD) {
    return app.inject({
      method: 'POST',
      url: LOGIN,
      payload: { email, password },
    });
  }

  function mfa(
    method: 'POST' | 'DELETE',
    url: string,
    payload: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      payload,
    });
  }

  function seedFactor(status: 'pending' | 'enabled') {
    state.mfaFactors.set(USER_ID, {
      factorId: FACTOR_ID,
      status,
      email: EMAIL,
      secret: TOTP_SECRET,
    });
  }

  async function failFiveTimes(request: () => Promise<{ statusCode: number }>) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request()).statusCode).toBe(401);
    }
  }

  it('refuses a correct login before password verification after five failures and returns Retry-After', async () => {
    await failFiveTimes(() => login(EMAIL, 'wrong password'));
    const verificationsBeforeLockout = verifyPassword.mock.calls.length;

    const blocked = await login();

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.json().error.retry_after_ms).toBe(15 * 60_000);
    expect(verifyPassword).toHaveBeenCalledTimes(verificationsBeforeLockout);
  });

  it('uses the shared IP budget to block a different account before password verification', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (await login(`unknown${attempt}@example.com`, 'wrong password'))
          .statusCode,
      ).toBe(401);
    }
    const verificationsBeforeLockout = verifyPassword.mock.calls.length;

    const blocked = await login();

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('300');
    expect(verifyPassword).toHaveBeenCalledTimes(verificationsBeforeLockout);
  });

  it('returns the longer retry when both login budgets are exhausted', async () => {
    now += 60_000;
    await failFiveTimes(() => login(EMAIL, 'wrong password'));
    now += 9 * 60_000;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (await login(`unknown${attempt}@example.com`, 'wrong password'))
          .statusCode,
      ).toBe(401);
    }

    const blocked = await login();

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('360');
    expect(blocked.json().error.retry_after_ms).toBe(6 * 60_000);
  });

  it('does not spend login budget for successful password proof that still needs MFA', async () => {
    seedFactor('enabled');

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await login()).statusCode).toBe(202);
    }
    expect(verifyPassword).toHaveBeenCalledTimes(6);
  });

  it('pre-checks MFA enrollment password before verification', async () => {
    await failFiveTimes(() =>
      mfa('POST', MFA_BEGIN, { password: 'wrong password' }),
    );
    const verificationsBeforeLockout = verifyPassword.mock.calls.length;

    const blocked = await mfa('POST', MFA_BEGIN, { password: PASSWORD });

    expect(blocked.statusCode).toBe(429);
    expect(verifyPassword).toHaveBeenCalledTimes(verificationsBeforeLockout);
  });

  it('pre-checks enrollment confirmation before decrypting and verifying TOTP', async () => {
    seedFactor('pending');
    await failFiveTimes(() => mfa('POST', MFA_CONFIRM, { code: '000000' }));
    const decryptionsBeforeLockout = decryptMfaSecret.mock.calls.length;

    const blocked = await mfa('POST', MFA_CONFIRM, { code: TOTP_CODE });

    expect(blocked.statusCode).toBe(429);
    expect(decryptMfaSecret).toHaveBeenCalledTimes(decryptionsBeforeLockout);
  });

  it('pre-checks MFA removal password before verification', async () => {
    seedFactor('enabled');
    await failFiveTimes(() =>
      mfa('DELETE', MFA_REMOVE, { password: 'wrong password' }),
    );
    const verificationsBeforeLockout = verifyPassword.mock.calls.length;

    const blocked = await mfa('DELETE', MFA_REMOVE, { password: PASSWORD });

    expect(blocked.statusCode).toBe(429);
    expect(verifyPassword).toHaveBeenCalledTimes(verificationsBeforeLockout);
  });

  it('pre-checks TOTP removal before decrypting and verifying the factor', async () => {
    seedFactor('enabled');
    await failFiveTimes(() => mfa('DELETE', MFA_REMOVE, { code: '000000' }));
    const decryptionsBeforeLockout = decryptMfaSecret.mock.calls.length;

    const blocked = await mfa('DELETE', MFA_REMOVE, { code: TOTP_CODE });

    expect(blocked.statusCode).toBe(429);
    expect(decryptMfaSecret).toHaveBeenCalledTimes(decryptionsBeforeLockout);
  });

  it('uses forwarded IP only after BFF authentication and ignores it for direct Bearer calls', async () => {
    seedFactor('pending');
    await failFiveTimes(() => mfa('POST', MFA_CONFIRM, { code: '000000' }));

    const forgedForwardedIp = await mfa(
      'POST',
      MFA_CONFIRM,
      { code: TOTP_CODE },
      { 'x-aihub-end-user-ip': OTHER_END_USER_IP },
    );
    expect(forgedForwardedIp.statusCode).toBe(429);

    state.reset();
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: '$argon2id$fake',
    });
    seedFactor('pending');
    const bffHeaders = {
      'x-aihub-client-secret': SECRET,
      'x-aihub-end-user-ip': END_USER_IP,
    };
    await failFiveTimes(() =>
      mfa('POST', MFA_CONFIRM, { code: '000000' }, bffHeaders),
    );

    const otherEndUser = await mfa(
      'POST',
      MFA_CONFIRM,
      { code: '000000' },
      {
        'x-aihub-client-secret': SECRET,
        'x-aihub-end-user-ip': OTHER_END_USER_IP,
      },
    );
    expect(otherEndUser.statusCode).toBe(401);
  });

  it('fails closed for an authenticated BFF without a valid end-user IP', async () => {
    seedFactor('pending');

    const response = await mfa(
      'POST',
      MFA_CONFIRM,
      { code: '000000' },
      { 'x-aihub-client-secret': SECRET, 'x-aihub-end-user-ip': 'not-an-ip' },
    );

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('AUTH_WEB_SESSION_UNAVAILABLE');
    expect(decryptMfaSecret).not.toHaveBeenCalled();
  });
});
