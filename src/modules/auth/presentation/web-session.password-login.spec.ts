import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';
import type { LightMyRequestResponse } from 'fastify';

import { AppModule } from '@/app.module';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import { MfaRequiredResponseSchema } from '@/contracts/auth/local-auth';
import { CreateWebSessionResponseSchema } from '@/contracts/auth/web-session';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { AUTH_CLOCK } from '@/modules/auth/local-credentials/application/local-auth.service';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/local-credentials/application/password-hasher.port';
import {
  AUTH_MFA_SERVICE,
  type AuthMfaServicePort,
} from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from '@/modules/auth/password-reset/application/password-reset-token.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import {
  type InMemoryAuthState,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryPasswordResetTokenAdapter } from '@/modules/auth/testing/in-memory-password-reset-token.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from '@/modules/auth/testing/in-memory-web-session.adapter';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/verification/application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '@/modules/auth/verification/application/verification-token.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/web-session-repository.port';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const RESET_PASSWORD_URL = '/v1/auth/reset-password';
const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
const END_USER_IP = '203.0.113.10';
const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

class FakeClock {
  value = new Date(NOW.getTime());
  now(): Date {
    return new Date(this.value);
  }
}

class HasherFake implements PasswordHasherPort {
  result = true;
  async hash(password: string): Promise<string> {
    return `$argon2id$fake:${password}`;
  }
  needsRehash(): boolean {
    return false;
  }
  async verify(): Promise<boolean> {
    return this.result;
  }
}

class LimiterFake implements AuthRateLimiterPort {
  allowed = true;
  calls: Parameters<AuthRateLimiterPort['consume']>[0][] = [];

  async check(): Promise<{ allowed: boolean }> {
    return { allowed: this.allowed };
  }

  async consume(
    input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ allowed: boolean }> {
    this.calls.push(input);
    return { allowed: this.allowed };
  }
}

class MfaFake implements AuthMfaServicePort {
  loginResult: Awaited<ReturnType<AuthMfaServicePort['loginProof']>> = {
    kind: 'none',
  };

  async loginProof() {
    return this.loginResult;
  }

  async beginEnrollment() {
    return { secret: 'A'.repeat(32), otpauthUri: 'otpauth://totp/AIHUB:test' };
  }

  async confirmEnrollment() {
    return ['ABCD-EFGH-IJKL-MNOP'];
  }

  async removeFactor(): Promise<void> {}
}

/** Hashes reversibly, so a test can seed the hash of a binding it knows. */
class VerificationTokenFake implements VerificationTokenPort {
  issue(now: Date): ReturnType<VerificationTokenPort['issue']> {
    return {
      id: 'evt_01J00000000000000000000000',
      raw: 'issued-verification-token',
      hash: this.hash('issued-verification-token'),
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

/** Stands in for container stdout, so redaction is asserted against real lines. */
class CapturedLog {
  private readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  reset(): void {
    this.lines.length = 0;
  }
  text(): string {
    return this.lines.join('');
  }

  completion(): Record<string, unknown> {
    const line = this.lines.find((entry) =>
      entry.includes('"event":"request_completed"'),
    );
    if (line === undefined) {
      throw new Error('no request completion event was logged');
    }

    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      throw new Error('request completion event was not a JSON object');
    }
    return parsed;
  }
}

describe('web session HTTP boundary', () => {
  let app: NestFastifyApplication;
  let state: InMemoryAuthState;
  let webSessions: InMemoryWebSessionAdapter;
  let verificationTokens: InMemoryVerificationTokenAdapter;
  let hasher: HasherFake;
  let limiter: LimiterFake;
  let clock: FakeClock;
  let provisioned: { secret: string | undefined };
  let passwordResetTokens: InMemoryPasswordResetTokenAdapter;
  let passwordResetTokenIssuer: PasswordResetTokenPort;
  const log = new CapturedLog();
  const mfa = new MfaFake();

  beforeAll(async () => {
    state = createInMemoryAuthState();
    webSessions = new InMemoryWebSessionAdapter(state);
    verificationTokens = new InMemoryVerificationTokenAdapter(state);
    hasher = new HasherFake();
    limiter = new LimiterFake();
    clock = new FakeClock();
    provisioned = { secret: CLIENT_SECRET };
    passwordResetTokens = new InMemoryPasswordResetTokenAdapter(state);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(state))
      .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
      .useValue(verificationTokens)
      .overrideProvider(PASSWORD_RESET_TOKEN_REPOSITORY)
      .useValue(passwordResetTokens)
      .overrideProvider(VERIFICATION_TOKEN)
      .useValue(new VerificationTokenFake())
      .overrideProvider(WEB_SESSION_REPOSITORY)
      .useValue(webSessions)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(hasher)
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(limiter)
      .overrideProvider(AUTH_CLOCK)
      .useValue(clock)
      .overrideProvider(WEB_SESSION_CLIENT_SECRET)
      .useValue({ resolve: () => provisioned.secret })
      .overrideProvider(AUTH_MFA_SERVICE)
      .useValue(mfa)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        ...createRequestLogging(log),
        genReqId: () => generateRequestId(),
      }),
    );
    const fastify = app.getHttpAdapter().getInstance();
    await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
    registerRequestCompletionLog(fastify);
    await app.init();
    await fastify.ready();
    // Likewise the real reset-token issuer, so a seeded reset token is hashed
    // the way the route hashes the one it is handed.
    passwordResetTokenIssuer =
      app.get<PasswordResetTokenPort>(PASSWORD_RESET_TOKEN);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.reset();
    webSessions.failCreateWebSession = false;
    webSessions.failFindWebSession = false;
    webSessions.failRenewWebSession = false;
    webSessions.failRevokeWebSession = false;
    verificationTokens.failSessionWrite = false;
    hasher.result = true;
    limiter.allowed = true;
    limiter.calls = [];
    clock.value = new Date(NOW.getTime());
    provisioned.secret = CLIENT_SECRET;
    mfa.loginResult = { kind: 'none' };
    log.reset();
  });

  /** An account holder who already verified their email. */
  function seedActiveAccount(): void {
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: '$argon2id$fake',
    });
  }

  /**
   * A reset token the account holder received by email, opened through the
   * same durable write forgot-password uses.
   */
  async function openResetToken(
    email: string,
    userId: string,
  ): Promise<string> {
    const issued = passwordResetTokenIssuer.issue(clock.now());
    await passwordResetTokens.issuePasswordResetToken({
      email,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      now: clock.now(),
    });
    if (!state.passwordResetTokens.has(issued.hash)) {
      throw new Error(`no reset token was stored for ${userId}`);
    }
    return issued.raw;
  }

  function resetPassword(
    token: unknown,
    password = 'a new password that works',
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: RESET_PASSWORD_URL,
      headers: { 'content-type': 'application/json' },
      payload: { token, password },
    });
  }

  /** A create request whose client secret defaults to the provisioned one. */
  function create(
    options: {
      readonly secret?: string | null;
      readonly body?: unknown;
      readonly endUserIp?: string | null;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.endUserIp === null
        ? {}
        : {
            'x-aihub-end-user-ip': options.endUserIp ?? END_USER_IP,
          }),
    };
    if (options.secret !== null) {
      headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
    }
    return app.inject({
      method: 'POST',
      url: URL,
      headers,
      payload: options.body ?? { email: EMAIL, password: PASSWORD },
    });
  }
  it('rejects the old password when reset commits during password verification', async () => {
    seedActiveAccount();
    const resetToken = await openResetToken(EMAIL, USER_ID);
    const verifying = jest
      .spyOn(hasher, 'verify')
      .mockImplementationOnce(async () => {
        expect((await resetPassword(resetToken)).statusCode).toBe(204);
        // Argon2 successfully verified the old hash fetched before the reset.
        return true;
      });
    try {
      const response = await create();
      expect(response.statusCode).toBe(401);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'AUTH_CREDENTIALS_INVALID' },
      });
      expect(response.payload).not.toContain('web_session_token');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(state.webSessions.size).toBe(0);
      expect(limiter.calls.map((call) => call.scope)).toEqual([
        'login_ip',
        'login_email',
      ]);
    } finally {
      verifying.mockRestore();
    }
  });

  it('creates one web session for a valid password and returns its token and expiry in the body', async () => {
    seedActiveAccount();

    const response = await create();

    expect(response.statusCode).toBe(201);
    const body = Value.Parse(
      CreateWebSessionResponseSchema,
      response.json<unknown>(),
    );
    expect(body.data.web_session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.data.expires_at).toBe('2026-11-07T00:00:00.000Z');
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(state.webSessions.size).toBe(1);
  });

  it('returns MFA_REQUIRED without issuing a Web Session token', async () => {
    seedActiveAccount();
    mfa.loginResult = { kind: 'required' };

    const response = await create();

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(
      Value.Parse(MfaRequiredResponseSchema, response.json<unknown>()).data,
    ).toEqual({ status: 'MFA_REQUIRED' });
    expect(response.payload).not.toContain('web_session_token');
    expect(state.webSessions.size).toBe(0);
  });

  it('stores only the token hash and never sets a cookie', async () => {
    seedActiveAccount();

    const response = await create();
    const token = Value.Parse(
      CreateWebSessionResponseSchema,
      response.json<unknown>(),
    ).data.web_session_token;

    expect(response.headers['set-cookie']).toBeUndefined();
    const [stored] = [...state.webSessions.values()];
    expect(stored?.sessionId).toMatch(/^wbs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toBe(token);
    expect(JSON.stringify([...state.webSessions.values()])).not.toContain(
      token,
    );
  });

  it('marks every response no-store, whatever it answers', async () => {
    seedActiveAccount();
    provisioned.secret = undefined;
    const unavailable = await create();
    provisioned.secret = CLIENT_SECRET;
    const refused = await create({ secret: 'wrong' });
    const invalid = await create({ body: { email: EMAIL } });
    const created = await create();

    for (const response of [unavailable, refused, invalid, created]) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it.each([
    ['a missing client secret', null],
    ['a wrong client secret', 'not-the-secret'],
    ['an empty client secret', ''],
  ])(
    'refuses %s with one generic 401 before any lookup',
    async (_case, secret) => {
      seedActiveAccount();

      const response = await create({ secret });

      expect(response.statusCode).toBe(401);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(log.completion()['client_ip_source']).toBe('direct_peer');
      expect(limiter.calls).toEqual([]);
      expect(state.webSessions.size).toBe(0);
    },
  );

  it('labels a Web Session request as the BFF only after the client secret passes', async () => {
    seedActiveAccount();

    const response = await create();

    expect(response.statusCode).toBe(201);
    const completion = log.completion();
    expect(typeof completion.client_ip).toBe('string');
    expect(completion.client_ip_source).toBe('customer_web_bff');
  });

  it('answers 503 with no credential when the deployment provisioned no secret', async () => {
    seedActiveAccount();
    provisioned.secret = undefined;

    const response = await create();

    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
    });
    expect(response.payload).not.toContain('web_session_token');
    expect(state.webSessions.size).toBe(0);
  });

  it('keeps every credential failure generic and consumes the email limit', async () => {
    const rejected = await create();

    expect(rejected.statusCode).toBe(401);
    expect(rejected.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(limiter.calls.map((call) => call.scope)).toEqual([
      'login_ip',
      'login_email',
    ]);
    expect(state.webSessions.size).toBe(0);
  });

  it.each([
    [
      'a wrong password',
      (): void => {
        seedActiveAccount();
        hasher.result = false;
      },
    ],
    ['an unknown email', (): void => {}],
    [
      'a pending-verification account',
      (): void => {
        seedAccount(state, {
          userId: USER_ID,
          email: EMAIL,
          passwordHash: '$argon2id$fake',
          status: 'pending_verification',
        });
      },
    ],
    [
      'a disabled account',
      (): void => {
        seedActiveAccount();
        const account = state.accounts.get(USER_ID);
        if (account !== undefined) account.status = 'disabled';
      },
    ],
  ])('refuses %s the same way', async (_case, arrange) => {
    arrange();

    const response = await create();

    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_CREDENTIALS_INVALID' },
    });
    expect(response.payload).not.toContain(EMAIL);
    expect(response.payload).not.toContain('pending_verification');
    expect(response.payload).not.toContain('disabled');
    expect(state.webSessions.size).toBe(0);
  });

  // The login limits count failures, exactly as login counts them: a correct
  // password consumes nothing, so a rate-limited caller is one that first failed
  // the credential check.
  it('answers a rate-limited caller 429 rather than a session', async () => {
    hasher.result = false;
    limiter.allowed = false;

    const response = await create();

    expect(response.statusCode).toBe(429);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect(state.webSessions.size).toBe(0);
  });

  it('fails closed with a 503 and no token when the durable write fails', async () => {
    seedActiveAccount();
    webSessions.failCreateWebSession = true;

    const response = await create();

    expect(response.statusCode).toBe(503);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.payload).not.toContain('web_session_token');
    expect(state.webSessions.size).toBe(0);
  });

  it('keeps the client secret and the token out of every log line', async () => {
    seedActiveAccount();
    await create();
    await create({ secret: 'wrong-secret-value' });

    const written = log.text();
    expect(written).not.toContain(CLIENT_SECRET);
    expect(written).not.toContain('wrong-secret-value');
    for (const [hash] of state.webSessions) {
      expect(written).not.toContain(hash);
    }
  });

  it('expires the session 30 days after creation', async () => {
    seedActiveAccount();
    clock.value = new Date('2026-10-08T12:00:00.000Z');

    const response = await create();

    expect(
      Value.Parse(CreateWebSessionResponseSchema, response.json<unknown>()).data
        .expires_at,
    ).toBe('2026-11-07T12:00:00.000Z');
    expect([...state.webSessions.values()][0]?.expiresAt.getTime()).toBe(
      clock.value.getTime() + THIRTY_DAYS_MS,
    );
  });

  it('rejects an unknown field and a malformed password at the boundary', async () => {
    seedActiveAccount();

    const extra = await create({
      body: { email: EMAIL, password: PASSWORD, remember_me: true },
    });
    const short = await create({ body: { email: EMAIL, password: 'short' } });

    expect(extra.statusCode).toBe(400);
    expect(extra.json<unknown>()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(short.statusCode).toBe(400);
    expect(state.webSessions.size).toBe(0);
  });
});
