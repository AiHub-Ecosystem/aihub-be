import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { AppModule } from '@/app.module';
import { registerSecurityHeaders } from '@/common/http/security-headers.hook';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/local-credentials/application/password-hasher.port';
import { AUTH_MFA_SERVICE } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from '@/modules/auth/password-reset/application/password-reset-token.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { AUTH_CLOCK } from '@/modules/auth/shared/application/auth-clock';
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
import { MfaFake } from '@/modules/auth/testing/local-auth.controller.spec-support';
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

export const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
export const END_USER_IP = '203.0.113.10';
export const USER_ID = 'usr_01J00000000000000000000000';
export const EMAIL = 'person@example.com';
export const PASSWORD = 'correct horse battery';
export const NOW = new Date('2026-10-08T00:00:00.000Z');
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export class FakeClock {
  value = new Date(NOW.getTime());
  now(): Date {
    return new Date(this.value);
  }
}

export class HasherFake implements PasswordHasherPort {
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

export class LimiterFake implements AuthRateLimiterPort {
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
export class CapturedLog {
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

export interface WebSessionTestContext {
  app: NestFastifyApplication;
  state: InMemoryAuthState;
  webSessions: InMemoryWebSessionAdapter;
  verificationTokens: InMemoryVerificationTokenAdapter;
  hasher: HasherFake;
  limiter: LimiterFake;
  clock: FakeClock;
  provisioned: { secret: string | undefined };
  passwordResetTokens: InMemoryPasswordResetTokenAdapter;
  passwordResetTokenIssuer: PasswordResetTokenPort;
  verifier: UserAccessTokenVerifierPort;
  log: CapturedLog;
  mfa: MfaFake;
  reset: () => void;
}

export async function createWebSessionTestContext(
  registerRequestCompletionLog: (fastify: FastifyInstance) => void,
): Promise<WebSessionTestContext> {
  const state = createInMemoryAuthState();
  const webSessions = new InMemoryWebSessionAdapter(state);
  const verificationTokens = new InMemoryVerificationTokenAdapter(state);
  const hasher = new HasherFake();
  const limiter = new LimiterFake();
  const clock = new FakeClock();
  const provisioned = { secret: CLIENT_SECRET };
  const passwordResetTokens = new InMemoryPasswordResetTokenAdapter(state);
  const log = new CapturedLog();
  const mfa = new MfaFake();
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

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
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

  const reset = (): void => {
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
  };

  return {
    app,
    state,
    webSessions,
    verificationTokens,
    hasher,
    limiter,
    clock,
    provisioned,
    passwordResetTokens,
    // Keep these real providers for valid seeded tokens and issuance checks.
    passwordResetTokenIssuer:
      app.get<PasswordResetTokenPort>(PASSWORD_RESET_TOKEN),
    verifier: app.get<UserAccessTokenVerifierPort>(USER_ACCESS_TOKEN_VERIFIER),
    log,
    mfa,
    reset,
  };
}

export interface WebSessionTestSuite {
  readonly context: WebSessionTestContext;
}

export function createWebSessionTestSuite(
  registerRequestCompletionLog: (fastify: FastifyInstance) => void,
): WebSessionTestSuite {
  let context: WebSessionTestContext | undefined;
  beforeAll(async () => {
    context = await createWebSessionTestContext(registerRequestCompletionLog);
  });
  afterAll(async () => {
    await context?.app.close();
  });
  beforeEach(() => context?.reset());

  return {
    get context() {
      if (context === undefined) {
        throw new Error(
          'The Web Session test context has not been initialized',
        );
      }
      return context;
    },
  };
}

export interface AlternateCredential {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface WebSessionTestHelpers {
  seedActiveAccount(): void;
  webSessionToken(): Promise<string>;
  storedSession(): InMemoryWebSession;
  exchange(
    token: unknown,
    options?: {
      readonly secret?: string | null;
      readonly headers?: Record<string, string>;
    },
  ): Promise<LightMyRequestResponse>;
  create(options?: {
    readonly secret?: string | null;
    readonly body?: unknown;
    readonly endUserIp?: string | null;
  }): Promise<LightMyRequestResponse>;
}

export function createWebSessionTestHelpers(
  getContext: () => WebSessionTestContext,
  url: string,
): WebSessionTestHelpers {
  const create = (
    options: {
      readonly secret?: string | null;
      readonly body?: unknown;
      readonly endUserIp?: string | null;
    } = {},
  ): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.endUserIp === null
        ? {}
        : { 'x-aihub-end-user-ip': options.endUserIp ?? END_USER_IP }),
    };
    if (options.secret !== null) {
      headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
    }
    return getContext().app.inject({
      method: 'POST',
      url,
      headers,
      payload: options.body ?? { email: EMAIL, password: PASSWORD },
    });
  };

  return {
    seedActiveAccount: () => {
      seedAccount(getContext().state, {
        userId: USER_ID,
        email: EMAIL,
        passwordHash: '$argon2id$fake',
      });
    },
    webSessionToken: async () => {
      const created = await create();
      if (created.statusCode !== 201) {
        throw new Error('the web session was never created');
      }
      return (created.json() as { data: { web_session_token: string } }).data
        .web_session_token;
    },
    storedSession: () => {
      const [stored] = [...getContext().state.webSessions.values()];
      if (stored === undefined) {
        throw new Error('no web session is stored');
      }
      return stored;
    },
    exchange: (
      token,
      options: {
        readonly secret?: string | null;
        readonly headers?: Record<string, string>;
      } = {},
    ) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...options.headers,
      };
      if (options.secret !== null) {
        headers['x-aihub-client-secret'] = options.secret ?? CLIENT_SECRET;
      }
      return getContext().app.inject({
        method: 'POST',
        url: `${url}/exchange`,
        headers,
        payload: { web_session_token: token },
      });
    },
    create,
  };
}

export interface PasswordResetTestHelpers {
  openResetToken(email: string, userId: string): Promise<string>;
  resetPassword(
    token: unknown,
    password?: string,
  ): Promise<LightMyRequestResponse>;
}

export function createPasswordResetTestHelpers(
  getContext: () => WebSessionTestContext,
  url: string,
): PasswordResetTestHelpers {
  return {
    openResetToken: async (email, userId) => {
      const context = getContext();
      const issued = context.passwordResetTokenIssuer.issue(
        context.clock.now(),
      );
      await context.passwordResetTokens.issuePasswordResetToken({
        email,
        tokenId: issued.id,
        tokenHash: issued.hash,
        tokenExpiresAt: issued.expiresAt,
        now: context.clock.now(),
      });
      if (!context.state.passwordResetTokens.has(issued.hash)) {
        throw new Error(`no reset token was stored for ${userId}`);
      }
      return issued.raw;
    },
    resetPassword: (token, password = 'a new password that works') =>
      getContext().app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { token, password },
      }),
  };
}

export function expectWebSessionUnavailable(
  response: LightMyRequestResponse,
  state: InMemoryAuthState,
  assertNoSetCookie = false,
): void {
  expect(response.json<unknown>()).toMatchObject({
    error: { code: 'AUTH_WEB_SESSION_UNAVAILABLE' },
  });
  if (assertNoSetCookie) {
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  expect(response.payload).not.toContain('web_session_token');
  expect(state.webSessions.size).toBe(0);
}
