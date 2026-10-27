import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';

import { AppModule } from '@/app.module';
import { registerSecurityHeaders } from '@/common/http/security-headers.hook';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
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
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/web-session-repository.port';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
const RESET_PASSWORD_URL = '/v1/auth/reset-password';
const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
const END_USER_IP = '203.0.113.10';
const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const PASSWORD = 'correct horse battery';
const NOW = new Date('2026-10-08T00:00:00.000Z');

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
    registerSecurityHeaders(fastify);
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
  describe('password reset', () => {
    beforeEach(() => {
      seedActiveAccount();
      seedOtherActiveAccount();
    });

    it('ends every web session of the account and no session of another', async () => {
      const thisDevice = await webSessionToken();
      const otherDevice = await webSessionToken();
      const bystander = await create({
        body: { email: OTHER_EMAIL, password: PASSWORD },
      });
      const bystanderToken = (
        bystander.json() as { data: { web_session_token: string } }
      ).data.web_session_token;
      expect(state.webSessions.size).toBe(3);

      const reset = await resetPassword(await openResetToken(EMAIL, USER_ID));

      expect(reset.statusCode).toBe(204);
      // Whoever knew the old password loses access from every Customer Web
      // device, which is the whole point of ending them here.
      expect((await exchange(thisDevice)).statusCode).toBe(401);
      expect((await exchange(otherDevice)).statusCode).toBe(401);
      // A different account is untouched: this is not a log-out-everyone route.
      expect((await exchange(bystanderToken)).statusCode).toBe(200);
      const sessions = [...state.webSessions.values()];
      expect(
        sessions
          .filter((session) => session.userId === USER_ID)
          .map((session) => session.revokedAt),
      ).toEqual([clock.now(), clock.now()]);
      expect(
        sessions
          .filter((session) => session.userId !== USER_ID)
          .map((session) => session.revokedAt),
      ).toEqual([undefined]);
    });

    it('leaves every web session of the account alive when the reset token expired', async () => {
      const token = await webSessionToken();
      const resetToken = await openResetToken(EMAIL, USER_ID);
      clock.value = new Date(
        [...state.passwordResetTokens.values()][0]?.expiresAt.getTime() ?? 0,
      );

      const response = await resetPassword(resetToken);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' },
      });
      expect((await exchange(token)).statusCode).toBe(200);
      expect(storedSession().revokedAt).toBeUndefined();
    });

    it('leaves every web session of the account alive for an unknown reset token', async () => {
      const token = await webSessionToken();

      const response = await resetPassword('never-issued-reset-token');

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' },
      });
      expect((await exchange(token)).statusCode).toBe(200);
      expect(storedSession().revokedAt).toBeUndefined();
    });
  });
});
