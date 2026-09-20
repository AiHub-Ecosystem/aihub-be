import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { generateRequestId } from '../../../common/request-context/request-id';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '../application/auth-rate-limiter.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '../application/email-sender.port';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
  type LoginIdentity,
  type PasswordResetResult,
  type PasswordResetTarget,
  type RefreshTokenRecord,
} from '../application/local-auth-repository.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../application/password-hasher.port';
import {
  type IssuedPasswordResetToken,
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from '../application/password-reset-token.port';
import {
  type IssuedRefreshToken,
  REFRESH_TOKEN_ISSUER,
  type RefreshTokenIssuerPort,
} from '../application/refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  type UserAccessTokenIssuerPort,
} from '../application/user-access-token.port';
import {
  type IssuedVerificationToken,
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '../application/verification-token.port';

class RepositoryFake implements LocalAuthRepositoryPort {
  consumed = true;
  target = { email: 'person@example.com' };
  registered = 0;
  loginIdentity: LoginIdentity | undefined = {
    userId: 'usr_01J00000000000000000000000',
    passwordHash: '$argon2id$fake',
    status: 'active' as const,
  };
  refreshTokens = new Map<string, RefreshTokenRecord>();
  failCreateRefreshSession = false;
  passwordResetTarget: PasswordResetTarget | undefined = {
    email: 'person@example.com',
  };
  passwordResetResult: PasswordResetResult = {
    kind: 'reset',
  };

  async register(): Promise<void> {
    this.registered += 1;
  }

  async rotateVerificationToken() {
    return this.target;
  }

  async consumeVerificationToken(): Promise<boolean> {
    return this.consumed;
  }

  async checkPasswordResetToken() {
    return this.passwordResetResult.kind === 'reset'
      ? { kind: 'valid' as const }
      : this.passwordResetResult;
  }

  async issuePasswordResetToken(): Promise<PasswordResetTarget | undefined> {
    return this.passwordResetTarget;
  }

  async consumePasswordReset(): Promise<PasswordResetResult> {
    return this.passwordResetResult;
  }

  async findLoginIdentityByEmail() {
    return this.loginIdentity;
  }

  async findUserAccountStatus() {
    return this.loginIdentity?.status;
  }

  async createRefreshSession(input: {
    readonly userId: string;
    readonly token: IssuedRefreshToken;
    readonly issuedAt: Date;
  }): Promise<void> {
    if (this.failCreateRefreshSession) {
      throw new Error('durable store unavailable');
    }
    this.refreshTokens.set(input.token.hash, {
      tokenId: input.token.id,
      familyId: input.token.familyId,
      userId: input.userId,
      expiresAt: input.token.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
  }

  async findRefreshTokenByHash(tokenHash: string) {
    return this.refreshTokens.get(tokenHash);
  }

  async rotateRefreshToken(input: {
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly successor: IssuedRefreshToken;
    readonly now: Date;
  }) {
    const current = this.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return { kind: 'invalid' as const, reason: 'missing' as const };
    }
    if (this.loginIdentity?.status !== 'active') {
      return { kind: 'invalid' as const, reason: 'inactive' as const };
    }
    if (current.usedAt !== undefined) {
      await this.revokeRefreshFamilyByTokenHash({
        tokenHash: input.tokenHash,
        now: input.now,
      });
      return { kind: 'invalid' as const, reason: 'used' as const };
    }
    if (current.revokedAt !== undefined) {
      await this.revokeRefreshFamilyByTokenHash({
        tokenHash: input.tokenHash,
        now: input.now,
      });
      return { kind: 'invalid' as const, reason: 'revoked' as const };
    }
    if (current.expiresAt <= input.now) {
      return { kind: 'invalid' as const, reason: 'expired' as const };
    }
    this.refreshTokens.set(input.tokenHash, { ...current, usedAt: input.now });
    this.refreshTokens.set(input.successor.hash, {
      tokenId: input.successor.id,
      familyId: input.successor.familyId,
      userId: current.userId,
      expiresAt: input.successor.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
    return { kind: 'rotated' as const, userId: current.userId };
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    const current = this.refreshTokens.get(input.tokenHash);
    if (current === undefined) {
      return;
    }
    for (const [hash, token] of this.refreshTokens) {
      if (token.familyId === current.familyId) {
        this.refreshTokens.set(hash, { ...token, revokedAt: input.now });
      }
    }
  }
}

class SenderFake implements EmailSenderPort {
  fail = false;

  async sendVerificationEmail(): Promise<void> {
    if (this.fail) {
      throw new Error('provider failed');
    }
  }

  async sendPasswordResetEmail(): Promise<void> {
    if (this.fail) {
      throw new Error('provider failed');
    }
  }
}

class HasherFake implements PasswordHasherPort {
  result = true;

  async hash(): Promise<string> {
    return '$argon2id$fake';
  }

  async verify(): Promise<boolean> {
    return this.result;
  }
}

class TokenFake implements VerificationTokenPort {
  issue(now: Date): IssuedVerificationToken {
    return {
      id: 'evt_01J00000000000000000000000',
      raw: 'opaque-token',
      hash: 'hash-token',
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class PasswordResetTokenFake implements PasswordResetTokenPort {
  issue(now: Date): IssuedPasswordResetToken {
    return {
      id: 'prt_01J00000000000000000000000',
      raw: 'reset-token',
      hash: 'reset-hash',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    };
  }

  hash(raw: string): string {
    return `reset-hash:${raw}`;
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

class AccessTokenIssuerFake implements UserAccessTokenIssuerPort {
  fail = false;

  async issue(): Promise<{ token: string; expiresIn: number }> {
    if (this.fail) {
      throw new Error('access token issuer unavailable');
    }
    return { token: 'ey.fake.access', expiresIn: 900 };
  }
}

class RefreshTokenIssuerFake implements RefreshTokenIssuerPort {
  sequence = 0;

  issue(now: Date, familyId?: string): IssuedRefreshToken {
    this.sequence += 1;
    const raw = `refresh-${this.sequence}`;
    return {
      id: `rft_${this.sequence}`,
      familyId: familyId ?? `rfs_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

describe('local auth HTTP boundary', () => {
  let app: NestFastifyApplication;
  let repository: RepositoryFake;
  let sender: SenderFake;
  let hasher: HasherFake;
  let limiter: LimiterFake;
  let refreshTokenIssuer: RefreshTokenIssuerFake;
  let accessTokenIssuer: AccessTokenIssuerFake;

  beforeAll(async () => {
    repository = new RepositoryFake();
    sender = new SenderFake();
    hasher = new HasherFake();
    limiter = new LimiterFake();
    refreshTokenIssuer = new RefreshTokenIssuerFake();
    accessTokenIssuer = new AccessTokenIssuerFake();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(repository)
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(hasher)
      .overrideProvider(VERIFICATION_TOKEN)
      .useClass(TokenFake)
      .overrideProvider(PASSWORD_RESET_TOKEN)
      .useClass(PasswordResetTokenFake)
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(limiter)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(accessTokenIssuer)
      .overrideProvider(REFRESH_TOKEN_ISSUER)
      .useValue(refreshTokenIssuer)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    const fastify = app.getHttpAdapter().getInstance();
    await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers with a safe projection and verifies through the real HTTP stack', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ' Person@Example.com ',
        username: ' Person_01 ',
        password: 'correct horse battery',
      },
    });

    expect(register.statusCode).toBe(201);
    expect(register.json()).toEqual({
      data: {
        email: 'person@example.com',
        username: 'person_01',
        status: 'pending_verification',
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    expect(register.payload).not.toContain('argon2');

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'opaque-token' },
    });
    expect(verify.statusCode).toBe(204);
    expect(verify.payload).toBe('');
  });

  it('keeps malformed input generic and provider failures non-sensitive', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatchObject({ code: 'INVALID_REQUEST' });

    sender.fail = true;
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'second@example.com',
        username: 'second_01',
        password: 'correct horse battery',
      },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE' }),
    );
    expect(failed.payload).not.toContain('provider failed');
  });

  it('returns a bodyless generic 202 for resend', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.payload).toBe('');
  });

  it('returns a generic password-recovery envelope even when delivery fails', async () => {
    sender.fail = true;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      data: {
        message: 'If the account exists, reset instructions have been sent.',
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    expect(response.payload).not.toContain('reset-token');
  });

  it('resets the password with a bodyless no-store response and clears refresh state', async () => {
    repository.passwordResetResult = {
      kind: 'reset',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: {
        token: 'reset-token',
        password: 'new password that works',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('maps replayed reset tokens to the public invalid-token error', async () => {
    repository.passwordResetResult = {
      kind: 'invalid',
      reason: 'consumed',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: {
        token: 'reset-token',
        password: 'new password that works',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' }),
    );
    repository.passwordResetResult = {
      kind: 'reset',
    };
  });

  it('logs in through the real HTTP stack with a narrow no-store response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ' Person@Example.com ',
        password: '  exact password  ',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      data: {
        access_token: 'ey.fake.access',
        token_type: 'Bearer',
        expires_in: 900,
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    const setCookie = response.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie : [setCookie]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-aihub_refresh=.+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
        ),
      ]),
    );
  });

  it('keeps unknown and inactive login failures generic', async () => {
    repository.loginIdentity = undefined;
    hasher.result = false;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com', password: 'wrong password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_CREDENTIALS_INVALID' }),
    );
    expect(response.payload).not.toContain('nobody@example.com');
    expect(response.payload).not.toContain('pending_verification');
  });

  it('rejects extra login fields at the boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'person@example.com',
        password: 'correct horse battery',
        remember_me: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rotates the refresh cookie and revokes a reused family', async () => {
    repository.loginIdentity = {
      userId: 'usr_01J00000000000000000000000',
      passwordHash: '$argon2id$fake',
      status: 'active',
    };
    hasher.result = true;

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const loginCookie = String(login.headers['set-cookie']).split(';', 1)[0];

    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: loginCookie,
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(refresh.statusCode).toBe(200);
    expect(refresh.headers['cache-control']).toBe('no-store');
    expect(refresh.json()).toEqual({
      data: {
        access_token: 'ey.fake.access',
        token_type: 'Bearer',
        expires_in: 900,
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    const rotatedCookie = String(refresh.headers['set-cookie']).split(
      ';',
      1,
    )[0];
    expect(rotatedCookie).not.toBe(loginCookie);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_REFRESH_TOKEN_INVALID' }),
    );
    expect(String(replay.headers['set-cookie'])).toContain('Max-Age=0');

    const successorAfterReuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: rotatedCookie },
    });
    expect(successorAfterReuse.statusCode).toBe(401);
  });

  it('serializes concurrent refresh attempts so only one token rotates', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const loginCookie = String(login.headers['set-cookie']).split(';', 1)[0];

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: loginCookie },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie: loginCookie },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 401]);
  });

  it('rejects an expired or disabled refresh session over HTTP', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const loginCookie = String(login.headers['set-cookie']).split(';', 1)[0];
    if (loginCookie === undefined) {
      throw new Error('login did not set a refresh cookie');
    }
    const rawToken = loginCookie.slice(loginCookie.indexOf('=') + 1);
    const tokenHash = refreshTokenIssuer.hash(rawToken);
    const stored = repository.refreshTokens.get(tokenHash);
    if (stored === undefined) {
      throw new Error('refresh session was not persisted');
    }
    repository.refreshTokens.set(tokenHash, {
      ...stored,
      expiresAt: new Date(0),
    });

    const expired = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    expect(expired.statusCode).toBe(401);

    const activeLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const activeCookie = String(activeLogin.headers['set-cookie']).split(
      ';',
      1,
    )[0];
    repository.loginIdentity = {
      userId: 'usr_01J00000000000000000000000',
      passwordHash: '$argon2id$fake',
      status: 'disabled',
    };
    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: activeCookie },
    });
    expect(disabled.statusCode).toBe(401);
    repository.loginIdentity = {
      userId: 'usr_01J00000000000000000000000',
      passwordHash: '$argon2id$fake',
      status: 'active',
    };
  });

  it('fails closed without a cookie when durable session persistence fails', async () => {
    repository.failCreateRefreshSession = true;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    repository.failCreateRefreshSession = false;

    expect(response.statusCode).toBe(500);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.payload).not.toContain('ey.fake.access');
  });

  it('logs out idempotently and only revokes the selected login family', async () => {
    repository.loginIdentity = {
      userId: 'usr_01J00000000000000000000000',
      passwordHash: '$argon2id$fake',
      status: 'active',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const firstCookie = String(first.headers['set-cookie']).split(';', 1)[0];
    const secondCookie = String(second.headers['set-cookie']).split(';', 1)[0];

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: firstCookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.payload).toBe('');
    expect(logout.headers['cache-control']).toBe('no-store');
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

    const firstAfterLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: firstCookie },
    });
    expect(firstAfterLogout.statusCode).toBe(401);

    const secondAfterLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: secondCookie },
    });
    expect(secondAfterLogout.statusCode).toBe(200);

    const logoutAgain = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
    });
    expect(logoutAgain.statusCode).toBe(204);
    expect(logoutAgain.payload).toBe('');
  });

  it('rejects alternate refresh sources and non-empty bodies', async () => {
    const alternate = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh?query_value=alternate',
    });
    expect(alternate.statusCode).toBe(401);
    expect(alternate.json().error.code).toBe('AUTH_REFRESH_TOKEN_INVALID');

    const body = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'alternate' },
    });
    expect(body.statusCode).toBe(400);
    expect(body.json().error.code).toBe('INVALID_REQUEST');

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const validCookie = String(login.headers['set-cookie']).split(';', 1)[0];
    if (validCookie === undefined) {
      throw new Error('login did not set a refresh cookie');
    }
    const extraCookie = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${validCookie}; unrelated=value` },
    });
    expect(extraCookie.statusCode).toBe(401);
    expect(extraCookie.json().error.code).toBe('AUTH_REFRESH_TOKEN_INVALID');

    const authorization = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: validCookie,
        authorization: 'Bearer alternate',
      },
    });
    expect(authorization.statusCode).toBe(401);

    const duplicateCookie = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: `${validCookie}; ${validCookie}` },
    });
    expect(duplicateCookie.statusCode).toBe(401);

    const spacedDuplicate = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: `${validCookie.replace('=', ' =')}; ${validCookie}`,
      },
    });
    expect(spacedDuplicate.statusCode).toBe(401);
  });

  it('clears a rotated cookie when access-token issuance fails after commit', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'person@example.com', password: 'correct password' },
    });
    const loginCookie = String(login.headers['set-cookie']).split(';', 1)[0];

    accessTokenIssuer.fail = true;
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: loginCookie },
    });
    accessTokenIssuer.fail = false;

    expect(failed.statusCode).toBe(500);
    expect(String(failed.headers['set-cookie'])).toContain('Max-Age=0');
    expect(failed.payload).not.toContain('access token issuer unavailable');
  });
});
