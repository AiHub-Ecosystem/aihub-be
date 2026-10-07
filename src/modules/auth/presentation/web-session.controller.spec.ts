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
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import { AUTH_CLOCK } from '@/modules/auth/application/local-auth.service';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/application/password-hasher.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { WEB_SESSION_CLIENT_SECRET } from '@/modules/auth/application/web-session-client-secret.port';
import { WEB_SESSION_REPOSITORY } from '@/modules/auth/application/web-session-repository.port';
import {
  type InMemoryAuthState,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryWebSessionAdapter } from '@/modules/auth/testing/in-memory-web-session.adapter';
import { registerRequestCompletionLog } from '@/modules/metering/presentation/request-completion-log.hook';

const URL = '/v1/auth/web-sessions';
const CLIENT_SECRET = 'bff-client-secret-value-that-must-not-leak';
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
  let hasher: HasherFake;
  let limiter: LimiterFake;
  let clock: FakeClock;
  let provisioned: { secret: string | undefined };
  const log = new CapturedLog();

  beforeAll(async () => {
    state = createInMemoryAuthState();
    webSessions = new InMemoryWebSessionAdapter(state);
    hasher = new HasherFake();
    limiter = new LimiterFake();
    clock = new FakeClock();
    provisioned = { secret: CLIENT_SECRET };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(new InMemoryUserAccountAdapter(state))
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.reset();
    webSessions.failCreateWebSession = false;
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
});
