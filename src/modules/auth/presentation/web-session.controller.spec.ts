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
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import { AUTH_CLOCK } from '@/modules/auth/application/local-auth.service';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/application/password-hasher.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '@/modules/auth/application/verification-token.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/application/web-session-repository.port';
import {
  type InMemoryAuthState,
  type InMemoryWebSession,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { InMemoryWebSessionAdapter } from '@/modules/auth/testing/in-memory-web-session.adapter';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const VERIFICATION_URL = '/v1/auth/web-sessions/verification';
const EXCHANGE_URL = '/v1/auth/web-sessions/exchange';
const VERIFY_EMAIL_URL = '/v1/auth/verify-email';
const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
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
  const log = new CapturedLog();

  beforeAll(async () => {
    state = createInMemoryAuthState();
    webSessions = new InMemoryWebSessionAdapter(state);
    verificationTokens = new InMemoryVerificationTokenAdapter(state);
    hasher = new HasherFake();
    limiter = new LimiterFake();
    clock = new FakeClock();
    provisioned = { secret: CLIENT_SECRET };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(state))
      .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
      .useValue(verificationTokens)
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
    verificationTokens.failSessionWrite = false;
    hasher.result = true;
    limiter.allowed = true;
    limiter.calls = [];
    clock.value = new Date(NOW.getTime());
    provisioned.secret = CLIENT_SECRET;
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

  /** A create request whose client secret defaults to the provisioned one. */
  function create(
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
      url: URL,
      headers,
      payload: options.body ?? { email: EMAIL, password: PASSWORD },
    });
  }

  it('creates one web session for a valid password and returns its token and expiry in the body', async () => {
    seedActiveAccount();

    const response = await create();

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      data: { web_session_token: string; expires_at: string };
      meta: { request_id: string };
    };
    expect(body.data.web_session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.data.expires_at).toBe('2026-11-07T00:00:00.000Z');
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(state.webSessions.size).toBe(1);
  });

  it('stores only the token hash and never sets a cookie', async () => {
    seedActiveAccount();

    const response = await create();
    const token = (response.json() as { data: { web_session_token: string } })
      .data.web_session_token;

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
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      );
      expect(limiter.calls).toEqual([]);
      expect(state.webSessions.size).toBe(0);
    },
  );

  it('answers 503 with no credential when the deployment provisioned no secret', async () => {
    seedActiveAccount();
    provisioned.secret = undefined;

    const response = await create();

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' }),
    );
    expect(response.payload).not.toContain('web_session_token');
    expect(state.webSessions.size).toBe(0);
  });

  it('keeps every credential failure generic and consumes the login limits', async () => {
    const rejected = await create();

    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_CREDENTIALS_INVALID' }),
    );
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
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_CREDENTIALS_INVALID' }),
    );
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
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    expect(state.webSessions.size).toBe(0);
  });

  it('fails closed with a 503 and no token when the durable write fails', async () => {
    seedActiveAccount();
    webSessions.failCreateWebSession = true;

    const response = await create();

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_WEB_SESSION_UNAVAILABLE' }),
    );
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
      (response.json() as { data: { expires_at: string } }).data.expires_at,
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
    expect(extra.json().error.code).toBe('INVALID_REQUEST');
    expect(short.statusCode).toBe(400);
    expect(state.webSessions.size).toBe(0);
  });

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

    it('consumes the existing verification rate limit and adds no new dimension', async () => {
      limiter.allowed = false;

      const response = await signIn();

      expect(response.statusCode).toBe(429);
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'RATE_LIMITED' }),
      );
      expect(limiter.calls.map((call) => call.scope)).toEqual(['verify_ip']);
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

  describe('exchange', () => {
    beforeEach(() => {
      seedActiveAccount();
    });

    /** A credential placed somewhere the route refuses to read it from. */
    interface AlternateCredential {
      readonly url: string;
      readonly headers: Record<string, string>;
    }

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

    it('keeps the JWT when only the renewal write fails', async () => {
      const token = await webSessionToken();
      const createdExpiry = storedSession().expiresAt.getTime();
      webSessions.failRenewWebSession = true;

      const response = await exchange(token);

      expect(response.statusCode).toBe(200);
      expect(
        (
          await verifier.verify(
            (response.json() as { data: { access_token: string } }).data
              .access_token,
          )
        ).userId,
      ).toBe(USER_ID);
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

    it('refuses a disabled account and leaves its sessions in place', async () => {
      const token = await webSessionToken();
      const account = state.accounts.get(USER_ID);
      if (account === undefined) {
        throw new Error('the account was never seeded');
      }
      account.status = 'disabled';

      const response = await exchange(token);

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_WEB_SESSION_INVALID');
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
      expect(response.json().error).toEqual(
        expect.objectContaining({ code: 'AUTH_WEB_SESSION_INVALID' }),
      );
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
        expect(response.json().error.code).toBe('AUTH_WEB_SESSION_INVALID');
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

      const response = await exchange(token, { secret });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
      expect(limiter.calls).toEqual([]);
      // The session survives a refused caller: only the exchange was refused.
      expect(state.webSessions.size).toBe(1);
    });

    it('consumes the exchange limits on a failure and nothing on a success', async () => {
      const failed = await exchange('t'.repeat(43));

      expect(failed.statusCode).toBe(401);
      expect(limiter.calls.map((call) => call.scope)).toEqual([
        'web_session_exchange_ip',
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
      expect(response.json().error.code).toBe('RATE_LIMITED');
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 with no credential when the store cannot be read', async () => {
      const token = await webSessionToken();
      webSessions.failFindWebSession = true;

      const response = await exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AUTH_WEB_SESSION_UNAVAILABLE');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).not.toContain('access_token');
    });

    it('answers 503 when the deployment provisioned no client secret', async () => {
      const token = await webSessionToken();
      provisioned.secret = undefined;

      const response = await exchange(token);

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('AUTH_WEB_SESSION_UNAVAILABLE');
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
