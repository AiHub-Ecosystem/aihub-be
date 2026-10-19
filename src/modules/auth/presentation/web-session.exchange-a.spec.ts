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
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/web-session-repository.port';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
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
  describe('exchange', () => {
    beforeEach(() => {
      seedActiveAccount();
    });

    it('answers the login envelope with a User Access JWT the real issuer verifies', async () => {
      const token = await webSessionToken();

      const response = await exchange(token);

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { access_token: string; token_type: string; expires_in: number };
        meta: { request_id: string };
      };
      // The published login contract is the oracle: same fields, same
      // `expires_in`, and nothing else.
      expect(Value.Check(LoginResponseSchema, body)).toBe(true);
      expect(body.data.token_type).toBe('Bearer');
      expect(body.data.expires_in).toBe(900);
      expect(body.meta.request_id).toMatch(/^req_/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      const verified = await verifier.verify(body.data.access_token);
      expect(verified.userId).toBe(USER_ID);
      expect(verified.jti.length).toBeGreaterThan(0);
    });

    // The same issuer signs a login access token, so the claim set, audience,
    // and issuer are asserted rather than inferred: the existing Bearer
    // boundary has to accept this JWT without knowing where it came from.
    it('issues the same claim set, audience, and issuer as a login access token', async () => {
      const token = await webSessionToken();

      const response = await exchange(token);

      const claims = decodeJwt(
        (response.json() as { data: { access_token: string } }).data
          .access_token,
      );
      expect(Object.keys(claims).sort()).toEqual([
        'aud',
        'exp',
        'iat',
        'iss',
        'jti',
        'sub',
      ]);
      expect(claims.sub).toBe(USER_ID);
      expect(claims.iss).toBe(ACCESS_TOKEN_ISSUER);
      expect(claims.aud).toBe(ACCESS_TOKEN_AUDIENCE);
      // The published 15-minute maximum, in the token itself. `Number` keeps a
      // missing claim a failure instead of a silent zero.
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    });

    it('signs a different JWT on every exchange', async () => {
      const token = await webSessionToken();

      const first = await exchange(token);
      const second = await exchange(token);

      const accessTokenOf = (response: LightMyRequestResponse): string =>
        (response.json() as { data: { access_token: string } }).data
          .access_token;
      expect(accessTokenOf(first)).not.toBe(accessTokenOf(second));
      expect((await verifier.verify(accessTokenOf(first))).jti).not.toBe(
        (await verifier.verify(accessTokenOf(second))).jti,
      );
    });

    it('slides the expiry 30 days forward on a successful exchange', async () => {
      const token = await webSessionToken();
      clock.value = new Date(NOW.getTime() + 24 * HOUR_MS);

      const response = await exchange(token);

      expect(response.statusCode).toBe(200);
      expect(storedSession().expiresAt.getTime()).toBe(
        clock.value.getTime() + THIRTY_DAYS_MS,
      );
      // AIHUB stores nothing about the JWT it signed: the only durable state
      // an exchange moves is the session's own expiry.
      expect(JSON.stringify([...state.webSessions.values()])).not.toContain(
        (response.json() as { data: { access_token: string } }).data
          .access_token,
      );
    });

    it('writes no renewal inside the throttle window and renews after it', async () => {
      const token = await webSessionToken();
      const createdExpiry = storedSession().expiresAt.getTime();
      const createdRenewal = storedSession().lastRenewedAt.getTime();

      // Ten minutes of console activity, then two hours of it: the first burst
      // must not turn every exchange into a row update.
      clock.value = new Date(NOW.getTime() + 10 * 60 * 1000);
      const early = await exchange(token);

      expect(early.statusCode).toBe(200);
      expect(storedSession().expiresAt.getTime()).toBe(createdExpiry);
      expect(storedSession().lastRenewedAt.getTime()).toBe(createdRenewal);

      clock.value = new Date(NOW.getTime() + 2 * HOUR_MS);
      const later = await exchange(token);

      expect(later.statusCode).toBe(200);
      expect(storedSession().expiresAt.getTime()).toBe(
        clock.value.getTime() + THIRTY_DAYS_MS,
      );
      expect(storedSession().lastRenewedAt.getTime()).toBe(
        clock.value.getTime(),
      );
    });

    it('never moves the expiry backwards', async () => {
      const token = await webSessionToken();
      // A session that already expires later than 30 days from now, whose last
      // renewal is old enough to clear the throttle: the only thing left to
      // refuse is a renewal that would shorten it.
      const row = storedSession();
      const farFuture = new Date(clock.value.getTime() + 60 * 24 * HOUR_MS);
      row.expiresAt = farFuture;
      row.lastRenewedAt = new Date(clock.value.getTime() - 40 * 24 * HOUR_MS);

      const response = await exchange(token);

      expect(response.statusCode).toBe(200);
      expect(storedSession().expiresAt.getTime()).toBe(farFuture.getTime());
    });

    it('answers 503 with no credential when the renewal write fails', async () => {
      const token = await webSessionToken();
      const createdExpiry = storedSession().expiresAt.getTime();
      webSessions.failRenewWebSession = true;

      const response = await exchange(token);

      // Fail closed. A renewal AIHUB could not record is a temporary fault the
      // BFF must be able to tell from a bad session, so it keeps its cookie
      // instead of receiving a JWT for an exchange that never committed.
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' }),
      );
      expect(response.payload).not.toContain('access_token');
      expect(storedSession().expiresAt.getTime()).toBe(createdExpiry);
    });

    it('answers every concurrent exchange of one session', async () => {
      const token = await webSessionToken();

      const responses = await Promise.all([
        exchange(token),
        exchange(token),
        exchange(token),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200, 200,
      ]);
      const jtis = await Promise.all(
        responses.map(
          async (response) =>
            (
              await verifier.verify(
                (response.json() as { data: { access_token: string } }).data
                  .access_token,
              )
            ).jti,
        ),
      );
      expect(new Set(jtis).size).toBe(3);
      expect(state.webSessions.size).toBe(1);
    });

    it('refuses a session unused for exactly 30 days and answers one millisecond before', async () => {
      const token = await webSessionToken();
      clock.value = new Date(storedSession().expiresAt.getTime() - 1);

      const stillValid = await exchange(token);

      expect(stillValid.statusCode).toBe(200);
      clock.value = new Date(storedSession().expiresAt.getTime());
      const expired = await exchange(token);

      expect(expired.statusCode).toBe(401);
      expect(expired.json().error.code).toBe('AUTH_WEB_SESSION_INVALID');
    });
  });
});
