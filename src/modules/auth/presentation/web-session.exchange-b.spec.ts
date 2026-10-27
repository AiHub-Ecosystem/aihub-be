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

    it('refuses a disabled account and leaves its sessions in place', async () => {
      const token = await webSessionToken();
      const account = state.accounts.get(USER_ID);
      if (account === undefined) {
        throw new Error('the account was never seeded');
      }
      account.status = 'disabled';

      const response = await exchange(token);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_INVALID' },
      });
      // Disabling stops the session, it does not delete it: re-enabling the
      // account restores it, which is why nothing is revoked here.
      expect(state.webSessions.size).toBe(1);
      expect(storedSession().revokedAt).toBeUndefined();
    });

    it.each([
      [
        'an expired session',
        async (): Promise<string> => {
          const token = await webSessionToken();
          clock.value = new Date(storedSession().expiresAt.getTime());
          return token;
        },
      ],
      [
        'a revoked session',
        async (): Promise<string> => {
          const token = await webSessionToken();
          storedSession().revokedAt = clock.value;
          return token;
        },
      ],
      [
        'an unknown token',
        async (): Promise<string> => Promise.resolve('t'.repeat(43)),
      ],
      [
        'a malformed token',
        async (): Promise<string> =>
          Promise.resolve('%%% not a web session token %%%'),
      ],
    ])('answers one generic 401 for %s', async (_case, arrange) => {
      const token = await arrange();

      const response = await exchange(token);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_INVALID' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      // Nothing that distinguishes one unusable session from another.
      expect(response.payload).not.toContain(token);
      expect(response.payload).not.toContain('expired');
      expect(response.payload).not.toContain('revoked');
    });

    it.each([
      [
        'a Web Session cookie',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { cookie: `__Host-aihub_web_session=${token}` },
        }),
      ],
      [
        'a refresh cookie',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { cookie: `__Host-aihub_refresh=${token}` },
        }),
      ],
      [
        'an authorization header',
        (token: string): AlternateCredential => ({
          url: EXCHANGE_URL,
          headers: { authorization: `Bearer ${token}` },
        }),
      ],
      [
        'a query parameter',
        (token: string): AlternateCredential => ({
          url: `${EXCHANGE_URL}?web_session_token=${token}`,
          headers: {},
        }),
      ],
    ])(
      'refuses a token offered in %s rather than reading it',
      async (_case, offer) => {
        const token = await webSessionToken();
        // The body still carries a valid token, so only the alternate source
        // can explain the refusal.
        const { url, headers } = offer(token);

        const response = await app.inject({
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            'x-aihub-client-secret': CLIENT_SECRET,
            ...headers,
          },
          payload: { web_session_token: token },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: { code: 'AUTH_WEB_SESSION_INVALID' },
        });
      },
    );

    it.each([
      ['a missing client secret', null],
      ['a wrong client secret', 'not-the-secret'],
      ['an empty client secret', ''],
    ])('refuses %s before any session lookup', async (_case, secret) => {
      const token = await webSessionToken();
      // A store that would throw if it were reached: the answer stays `401`,
      // so the refusal came first and no row was looked up.
      webSessions.failFindWebSession = true;

      const response = await exchange(token, {
        secret,
        headers: { 'x-aihub-end-user-ip': '198.51.100.55' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      });
      expect(limiter.calls).toEqual([]);
      // The session survives a refused caller: only the exchange was refused.
      expect(state.webSessions.size).toBe(1);
    });

    it('consumes the exchange limits on a failure and nothing on a success', async () => {
      const failed = await exchange('t'.repeat(43));

      expect(failed.statusCode).toBe(401);
      expect(limiter.calls.map((call) => call.scope)).toEqual([
        'web_session_exchange_token',
      ]);
      // The per-token key is the stored hash, never the credential itself.
      const token = await webSessionToken();
      limiter.calls = [];
      const renewed = await exchange(token);

      expect(renewed.statusCode).toBe(200);
      expect(limiter.calls).toEqual([]);
    });

    it('answers a rate-limited caller 429 rather than a JWT', async () => {
      limiter.allowed = false;

      const response = await exchange('t'.repeat(43));

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        error: { code: 'RATE_LIMITED' },
      });
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 with no credential when the store cannot be read', async () => {
      const token = await webSessionToken();
      webSessions.failFindWebSession = true;

      const response = await exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 when the deployment provisioned no client secret', async () => {
      const token = await webSessionToken();
      provisioned.secret = undefined;

      const response = await exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
      });
      expect(response.payload).not.toContain('access_token');
    });

    it('marks every response no-store, whatever it answers', async () => {
      const token = await webSessionToken();
      const refused = await exchange('t'.repeat(43));
      const invalid = await app.inject({
        method: 'POST',
        url: EXCHANGE_URL,
        headers: { 'content-type': 'application/json' },
        payload: { web_session_token: token, remember_me: true },
      });
      const exchanged = await exchange(token);

      for (const response of [refused, invalid, exchanged]) {
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('keeps the client secret, the token, and the JWT out of every log line', async () => {
      const token = await webSessionToken();
      const exchanged = await exchange(token);
      await exchange(token, { secret: 'wrong-secret-value' });

      const written = log.text();
      expect(written).not.toContain(CLIENT_SECRET);
      expect(written).not.toContain('wrong-secret-value');
      expect(written).not.toContain(token);
      expect(written).not.toContain(
        (exchanged.json() as { data: { access_token: string } }).data
          .access_token,
      );
    });
  });
});
