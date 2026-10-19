import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';
import type { LightMyRequestResponse } from 'fastify';
import { decodeJwt } from 'jose';

import { AppModule } from '@/app.module';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import { LoginResponseSchema } from '@/contracts/auth/local-auth';
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
  type InMemoryWebSession,
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
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/web-session-repository.port';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const VERIFICATION_URL = '/v1/auth/web-sessions/verification';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
const LOGOUT_URL = '/v1/auth/web-sessions/logout';
const VERIFY_EMAIL_URL = '/v1/auth/verify-email';
const RESET_PASSWORD_URL = '/v1/auth/reset-password';
const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
const END_USER_IP = '203.0.113.10';
const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const NOW = new Date('2026-10-08T00:00:00.000Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The issuer and audience this deployment publishes for User Access JWTs. */
const ACCESS_TOKEN_ISSUER = 'https://api.test.aihub.example.com';
const ACCESS_TOKEN_AUDIENCE = 'aihub-user-api';
const BINDING = 'b'.repeat(43);
const VERIFICATION_TOKEN_VALUE = 'verification-token-value-under-test';

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

const OTHER_USER_ID = 'usr_01J00000000000000000000001';
const OTHER_EMAIL = 'someone-else@example.com';

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

    return JSON.parse(line) as Record<string, unknown>;
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
  let verifier: UserAccessTokenVerifierPort;
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
    // The real issuer, not a fake: the verifier is the oracle for "this is the
    // JWT login issues", because it rejects any other claim set, audience,
    // issuer, or lifetime.
    verifier = app.get<UserAccessTokenVerifierPort>(USER_ACCESS_TOKEN_VERIFIER);
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

  /** A second, unrelated account holder, so "every session" has an outside. */
  function seedOtherActiveAccount(): void {
    seedAccount(state, {
      userId: OTHER_USER_ID,
      email: OTHER_EMAIL,
      passwordHash: '$argon2id$fake',
    });
  }

  /**
   * A real Web Session token, created through the real route, so an exchange
   * test holds a credential rather than a fixture that could drift from it.
   */
  async function webSessionToken(): Promise<string> {
    const created = await create();
    if (created.statusCode !== 201) {
      throw new Error('the web session was never created');
    }
    return (created.json() as { data: { web_session_token: string } }).data
      .web_session_token;
  }

  /** The durable row itself, which is what the renewal rules change. */
  function storedSession(): InMemoryWebSession {
    const [stored] = [...state.webSessions.values()];
    if (stored === undefined) {
      throw new Error('no web session is stored');
    }
    return stored;
  }

  /** A credential placed somewhere a Web Session route refuses to read it from. */
  interface AlternateCredential {
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  /**
   * An exchange request whose client secret defaults to the provisioned one.
   * Shared by every describe here: whether a session is still alive is observed
   * by exchanging it, never by reading the row.
   */
  function exchange(
    token: unknown,
    options: {
      readonly secret?: string | null;
      readonly headers?: Record<string, string>;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...options.headers,
    };
    if (options.secret !== null) {
      headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
    }
    return app.inject({
      method: 'POST',
      url: EXCHANGE_URL,
      headers,
      payload: { web_session_token: token },
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
  describe('Verification Sign-in', () => {
    beforeEach(() => {
      seedAccount(state, {
        userId: USER_ID,
        email: EMAIL,
        passwordHash: '$argon2id$fake',
        status: 'pending_verification',
      });
      state.verificationTokens.set(`hash:${VERIFICATION_TOKEN_VALUE}`, {
        tokenId: 'evt_01J00000000000000000000000',
        userId: USER_ID,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        browserBindingHash: `hash:${BINDING}`,
        consumedAt: undefined,
        consumedReason: undefined,
        signedInAt: undefined,
      });
    });

    function signIn(
      options: {
        readonly secret?: string | null;
        readonly body?: unknown;
      } = {},
    ): Promise<LightMyRequestResponse> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (options.secret !== null) {
        headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
      }
      return app.inject({
        method: 'POST',
        url: VERIFICATION_URL,
        headers,
        payload:
          options.body ??
          ({ token: VERIFICATION_TOKEN_VALUE, browser_binding: BINDING } as {
            token: string;
            browser_binding: string;
          }),
      });
    }

    it('creates one web session for a bound token and returns its token and expiry in the body', async () => {
      const response = await signIn();

      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        data: { web_session_token: string; expires_at: string };
        meta: { request_id: string };
      };
      expect(body.data.web_session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.data.expires_at).toBe('2026-11-07T00:00:00.000Z');
      expect(body.meta.request_id).toMatch(/^req_/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(state.webSessions.size).toBe(1);
      expect([...state.webSessions.values()][0]?.userId).toBe(USER_ID);
      expect(state.refreshTokens.size).toBe(0);
      expect(state.accounts.get(USER_ID)?.status).toBe('active');
    });

    it.each([
      ['no binding', {}],
      ['a different browser', { browser_binding: 'c'.repeat(43) }],
    ])(
      'verifies the email but signs nobody in with %s',
      async (_case, extra) => {
        const response = await signIn({
          body: { token: VERIFICATION_TOKEN_VALUE, ...extra },
        });

        expect(response.statusCode).toBe(204);
        expect(response.payload).toBe('');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(state.webSessions.size).toBe(0);
        expect(state.accounts.get(USER_ID)?.status).toBe('active');
      },
    );

    it('creates nothing further on a replay after a successful sign-in', async () => {
      await signIn();

      const replay = await signIn();

      expect(replay.statusCode).toBe(204);
      expect(state.webSessions.size).toBe(1);
    });

    it('creates at most one session in total across both session kinds', async () => {
      await signIn();
      const viaVerifyEmail = await app.inject({
        method: 'POST',
        url: VERIFY_EMAIL_URL,
        headers: { 'content-type': 'application/json' },
        payload: { token: VERIFICATION_TOKEN_VALUE, browser_binding: BINDING },
      });

      expect(viaVerifyEmail.statusCode).toBe(204);
      expect(state.refreshTokens.size).toBe(0);
      expect(state.webSessions.size).toBe(1);
    });

    it('creates no web session for a token a verify already spent on a refresh session', async () => {
      const viaVerifyEmail = await app.inject({
        method: 'POST',
        url: VERIFY_EMAIL_URL,
        headers: { 'content-type': 'application/json' },
        payload: { token: VERIFICATION_TOKEN_VALUE, browser_binding: BINDING },
      });
      expect(viaVerifyEmail.statusCode).toBe(200);

      const response = await signIn();

      expect(response.statusCode).toBe(204);
      expect(state.webSessions.size).toBe(0);
      expect(state.refreshTokens.size).toBe(1);
    });

    it('creates at most one web session for concurrent submissions of the same token', async () => {
      const responses = await Promise.all([signIn(), signIn(), signIn()]);

      const created = responses.filter(
        (response) => response.statusCode === 201,
      );
      expect(created).toHaveLength(1);
      expect(state.webSessions.size).toBe(1);
    });

    it('answers an invalid verification token the same failure as the verify route', async () => {
      const response = await signIn({ body: { token: 'not-a-real-token' } });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'AUTH_VERIFICATION_TOKEN_INVALID' }),
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(state.webSessions.size).toBe(0);
    });

    it('bounds BFF verification attempts by the token hash', async () => {
      limiter.allowed = false;

      const response = await signIn();

      expect(response.statusCode).toBe(429);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'RATE_LIMITED' }),
      );
      expect(limiter.calls.map((call) => call.scope)).toEqual([
        'web_session_verification_token',
      ]);
      expect(state.webSessions.size).toBe(0);
    });

    it.each([
      ['a missing client secret', null],
      ['a wrong client secret', 'not-the-secret'],
    ])(
      'refuses %s before the token is even looked at',
      async (_case, secret) => {
        const response = await signIn({ secret });

        expect(response.statusCode).toBe(401);
        expect(response.json().error).toEqual(
          expect.objectContaining({ code: 'UNAUTHORIZED' }),
        );
        expect(limiter.calls).toEqual([]);
        expect(state.webSessions.size).toBe(0);
        expect(state.accounts.get(USER_ID)?.status).toBe(
          'pending_verification',
        );
      },
    );

    it('answers 503 with no credential when no client secret is provisioned', async () => {
      provisioned.secret = undefined;

      const response = await signIn();

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' }),
      );
      expect(response.payload).not.toContain('web_session_token');
      expect(state.webSessions.size).toBe(0);
    });

    it('fails closed with a 503 and no token when the durable write fails', async () => {
      verificationTokens.failSessionWrite = true;

      const response = await signIn();

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' }),
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.payload).not.toContain('web_session_token');
      expect(state.webSessions.size).toBe(0);
    });

    it('rejects an unknown field and a malformed binding at the boundary', async () => {
      const extra = await signIn({
        body: {
          token: VERIFICATION_TOKEN_VALUE,
          browser_binding: BINDING,
          sign_in: true,
        },
      });
      const malformed = await signIn({
        body: { token: VERIFICATION_TOKEN_VALUE, browser_binding: 'too-short' },
      });

      expect(extra.statusCode).toBe(400);
      expect(extra.json().error.code).toBe('INVALID_REQUEST');
      expect(malformed.statusCode).toBe(400);
      expect(state.webSessions.size).toBe(0);
    });

    it('keeps the client secret, the token, and the binding out of every log line', async () => {
      await signIn();
      await signIn({ secret: 'wrong-secret-value' });

      const written = log.text();
      expect(written).not.toContain(CLIENT_SECRET);
      expect(written).not.toContain('wrong-secret-value');
      expect(written).not.toContain(BINDING);
      for (const [hash] of state.webSessions) {
        expect(written).not.toContain(hash);
      }
    });
  });
});
