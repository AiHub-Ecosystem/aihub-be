import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { LightMyRequestResponse } from 'fastify';

import { AppModule } from '@/app.module';
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
  type UserAccessTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/web-session-repository.port';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const VERIFICATION_URL = '/v1/auth/web-sessions/verification';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
const LOGOUT_URL = '/v1/auth/web-sessions/logout';
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
  describe('revocation racing an exchange', () => {
    beforeEach(seedActiveAccount);

    it.each(['logout', 'password reset'] as const)(
      'returns no JWT when %s commits while signing is in flight',
      async (action) => {
        const token = await webSessionToken();
        const resetToken =
          action === 'password reset'
            ? await openResetToken(EMAIL, USER_ID)
            : undefined;
        const issuer = app.get<UserAccessTokenIssuerPort>(
          USER_ACCESS_TOKEN_ISSUER,
        );
        const issue = issuer.issue.bind(issuer);
        const paused = jest
          .spyOn(issuer, 'issue')
          .mockImplementationOnce(async (userId) => {
            const revoked =
              resetToken === undefined
                ? await app.inject({
                    method: 'POST',
                    url: LOGOUT_URL,
                    headers: { 'x-aihub-client-secret': CLIENT_SECRET },
                    payload: { web_session_token: token },
                  })
                : await resetPassword(resetToken);
            expect(revoked.statusCode).toBe(204);
            return issue(userId);
          });
        try {
          const response = await exchange(token);
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({
            error: { code: 'AUTH_WEB_SESSION_INVALID' },
          });
          expect(response.payload).not.toContain('access_token');
          expect(response.headers['cache-control']).toBe('no-store');
        } finally {
          paused.mockRestore();
        }
      },
    );
  });

  it('fails closed when the final validity read is unavailable after signing', async () => {
    seedActiveAccount();
    const token = await webSessionToken();
    const issuer = app.get<UserAccessTokenIssuerPort>(USER_ACCESS_TOKEN_ISSUER);
    const issue = issuer.issue.bind(issuer);
    const unavailable = jest
      .spyOn(issuer, 'issue')
      .mockImplementationOnce(async (userId) => {
        const signed = await issue(userId);
        webSessions.failFindWebSession = true;
        return signed;
      });
    try {
      const response = await exchange(token);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('access_token');
    } finally {
      unavailable.mockRestore();
    }
  });

  it.each([URL, VERIFICATION_URL, EXCHANGE_URL, LOGOUT_URL])(
    'authenticates the BFF before validating the body on %s',
    async (url) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { unexpected: 'field' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});
