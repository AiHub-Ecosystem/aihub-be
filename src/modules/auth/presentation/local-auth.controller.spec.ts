import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { APP_FASTIFY_PROXY_OPTIONS } from '@/app-fastify-proxy-options';
import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import { ReadCurrentUserResponseSchema } from '@/contracts/auth/local-auth';
import {
  AUTH_MFA_SERVICE,
  type AuthMfaServicePort,
} from '@/modules/auth/application/auth-mfa-repository.port';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from '@/modules/auth/application/auth-rate-limiter.port';
import {
  EMAIL_PAYLOAD_CIPHER,
  type EmailDeliveryPayload,
  type EmailPayloadCipherPort,
} from '@/modules/auth/application/email-delivery-request.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '@/modules/auth/application/password-hasher.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from '@/modules/auth/application/password-reset-token-repository.port';
import {
  type IssuedPasswordResetToken,
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from '@/modules/auth/application/password-reset-token.port';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/application/refresh-session-repository.port';
import {
  type IssuedRefreshToken,
  REFRESH_TOKEN_ISSUER,
  type RefreshTokenIssuerPort,
} from '@/modules/auth/application/refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/application/verification-token-repository.port';
import {
  type IssuedVerificationToken,
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '@/modules/auth/application/verification-token.port';
import {
  type InMemoryAccount,
  type InMemoryAuthState,
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryPasswordResetTokenAdapter } from '@/modules/auth/testing/in-memory-password-reset-token.adapter';
import { InMemoryRefreshSessionAdapter } from '@/modules/auth/testing/in-memory-refresh-session.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';

const USER_ID = 'usr_01J00000000000000000000000';
const EMAIL = 'person@example.com';
const RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

/**
 * Reversible so a test can read the durable handoff. The request path never
 * calls a provider, so this stands in for the whole Resend boundary.
 */
class PayloadCipherFake implements EmailPayloadCipherPort {
  encrypt(plaintext: string): string {
    const sealed = Buffer.from(plaintext, 'utf8').toString('base64url');
    return `sealed:${sealed}`;
  }

  decrypt(envelope: string): string {
    return Buffer.from(envelope.slice('sealed:'.length), 'base64url').toString(
      'utf8',
    );
  }
}

class HasherFake implements PasswordHasherPort {
  result = true;
  verifyByHash = false;

  async hash(password: string): Promise<string> {
    return `$argon2id$fake:${password}`;
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return this.verifyByHash
      ? passwordHash === (await this.hash(password))
      : this.result;
  }
}

class TokenFake implements VerificationTokenPort {
  issued: IssuedVerificationToken[] = [];
  private sequence = 0;

  reset(): void {
    this.issued = [];
    this.sequence = 0;
  }

  issue(now: Date): IssuedVerificationToken {
    this.sequence += 1;
    const raw = `opaque-token-${this.sequence}`;
    const token = {
      id: `evt_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 86_400_000),
    };
    this.issued.push(token);
    return token;
  }

  hash(raw: string): string {
    return `hash:${raw}`;
  }
}

class PasswordResetTokenFake implements PasswordResetTokenPort {
  issued: IssuedPasswordResetToken[] = [];
  private sequence = 0;

  reset(): void {
    this.issued = [];
    this.sequence = 0;
  }

  issue(now: Date): IssuedPasswordResetToken {
    this.sequence += 1;
    const raw = `reset-token-${this.sequence}`;
    const token = {
      id: `prt_${this.sequence}`,
      raw,
      hash: this.hash(raw),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    };
    this.issued.push(token);
    return token;
  }

  hash(raw: string): string {
    return `reset-hash:${raw}`;
  }
}

class LimiterFake implements AuthRateLimiterPort {
  allowed = true;
  calls: Parameters<AuthRateLimiterPort['consume']>[0][] = [];
  blockedKeys = new Set<string>();

  async consume(
    input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ allowed: boolean }> {
    this.calls.push(input);
    return {
      allowed:
        this.allowed && !this.blockedKeys.has(`${input.scope}:${input.key}`),
    };
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
  private sequence = 0;

  reset(): void {
    this.sequence = 0;
  }

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
  let state: InMemoryAuthState;
  let userAccounts: InMemoryUserAccountAdapter;
  let verificationTokens: InMemoryVerificationTokenAdapter;
  let passwordResetTokens: InMemoryPasswordResetTokenAdapter;
  let refreshSessions: InMemoryRefreshSessionAdapter;
  let cipher: PayloadCipherFake;
  let hasher: HasherFake;
  let limiter: LimiterFake;
  let tokenIssuer: TokenFake;
  let passwordResetTokenIssuer: PasswordResetTokenFake;
  let refreshTokenIssuer: RefreshTokenIssuerFake;
  let accessTokenIssuer: AccessTokenIssuerFake;
  let mfa: MfaFake;

  beforeAll(async () => {
    state = createInMemoryAuthState();
    userAccounts = new InMemoryUserAccountAdapter(state);
    verificationTokens = new InMemoryVerificationTokenAdapter(state);
    passwordResetTokens = new InMemoryPasswordResetTokenAdapter(state);
    refreshSessions = new InMemoryRefreshSessionAdapter(state);
    cipher = new PayloadCipherFake();
    hasher = new HasherFake();
    limiter = new LimiterFake();
    tokenIssuer = new TokenFake();
    passwordResetTokenIssuer = new PasswordResetTokenFake();
    refreshTokenIssuer = new RefreshTokenIssuerFake();
    accessTokenIssuer = new AccessTokenIssuerFake();
    mfa = new MfaFake();
    const accessTokenVerifier: UserAccessTokenVerifierPort = {
      verify: async (token) => {
        if (token === 'valid.user.access') {
          return { userId: USER_ID, jti: 'jti_current_user' };
        }
        throw new Error('invalid token');
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccounts)
      .overrideProvider(VERIFICATION_TOKEN_REPOSITORY)
      .useValue(verificationTokens)
      .overrideProvider(PASSWORD_RESET_TOKEN_REPOSITORY)
      .useValue(passwordResetTokens)
      .overrideProvider(REFRESH_SESSION_REPOSITORY)
      .useValue(refreshSessions)
      .overrideProvider(EMAIL_PAYLOAD_CIPHER)
      .useValue(cipher)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(hasher)
      .overrideProvider(VERIFICATION_TOKEN)
      .useValue(tokenIssuer)
      .overrideProvider(PASSWORD_RESET_TOKEN)
      .useValue(passwordResetTokenIssuer)
      .overrideProvider(AUTH_RATE_LIMITER)
      .useValue(limiter)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(accessTokenIssuer)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(accessTokenVerifier)
      .overrideProvider(REFRESH_TOKEN_ISSUER)
      .useValue(refreshTokenIssuer)
      .overrideProvider(AUTH_MFA_SERVICE)
      .useValue(mfa)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        ...APP_FASTIFY_PROXY_OPTIONS,
        genReqId: () => generateRequestId(),
      }),
    );
    const fastify = app.getHttpAdapter().getInstance();
    await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.reset();
    hasher.result = true;
    hasher.verifyByHash = false;
    limiter.allowed = true;
    limiter.calls = [];
    limiter.blockedKeys.clear();
    accessTokenIssuer.fail = false;
    refreshSessions.failCreateRefreshSession = false;
    refreshSessions.failFindRefreshToken = false;
    tokenIssuer.reset();
    mfa.loginResult = { kind: 'none' };
    passwordResetTokenIssuer.reset();
    refreshTokenIssuer.reset();
  });

  it('uses the address nginx appends for separate local-auth IP budgets', async () => {
    limiter.blockedKeys.add('login_ip:198.51.100.10');

    const blockedCaller = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '172.16.7.1',
      headers: {
        'x-forwarded-for': '198.51.100.11, 198.51.100.10',
      },
      payload: { email: 'blocked@example.com', password: 'wrong password' },
    });
    const otherCaller = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '172.16.7.1',
      headers: {
        'x-forwarded-for': '198.51.100.10, 198.51.100.11',
      },
      payload: { email: 'other@example.com', password: 'wrong password' },
    });

    expect(blockedCaller.statusCode).toBe(429);
    expect(otherCaller.statusCode).toBe(401);
    expect(
      limiter.calls
        .filter((call) => call.scope === 'login_ip')
        .map((call) => call.key),
    ).toEqual(['198.51.100.10', '198.51.100.11']);
  });

  /** An account holder who already verified their email. */
  function seedActiveAccount(): void {
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      username: 'person_01',
      passwordHash: '$argon2id$fake',
    });
  }

  function account(): InMemoryAccount {
    const stored = state.accounts.get(USER_ID);
    if (stored === undefined) {
      throw new Error('the account was never seeded');
    }
    return stored;
  }

  function issuedVerificationToken(index = 0): string {
    const token = tokenIssuer.issued[index];
    if (token === undefined) {
      throw new Error(`no verification token was issued at position ${index}`);
    }
    return token.raw;
  }

  /** A password reset token the account holder received by email. */
  async function openResetToken(): Promise<string> {
    const now = new Date();
    const issued = passwordResetTokenIssuer.issue(now);
    await passwordResetTokens.issuePasswordResetToken({
      email: EMAIL,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      now,
    });
    return issued.raw;
  }

  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const setCookie = response.headers['set-cookie'];
    if (setCookie === undefined) {
      throw new Error('the response set no refresh cookie');
    }
    return String(setCookie).split(';', 1)[0] ?? '';
  }

  /** What the worker would read back out of the ciphertext once it claims a row. */
  function sealed(
    request: { readonly payloadCiphertext: string } | undefined,
  ): EmailDeliveryPayload {
    if (request === undefined) {
      throw new Error('no email delivery request was written');
    }
    return JSON.parse(
      cipher.decrypt(request.payloadCiphertext),
    ) as EmailDeliveryPayload;
  }

  it('returns only the authenticated account username with no-store caching', async () => {
    seedActiveAccount();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer valid.user.access' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Value.Check(ReadCurrentUserResponseSchema, response.json())).toBe(
      true,
    );
    expect(response.json()).toEqual({
      data: { username: 'person_01' },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
  });

  it('returns enrollment material and recovery codes only from their no-store MFA endpoints', async () => {
    seedActiveAccount();
    const headers = {
      authorization: 'Bearer valid.user.access',
      'content-type': 'application/json',
    };

    const enrollment = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrollment',
      headers,
      payload: { password: 'correct horse battery' },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(enrollment.headers['cache-control']).toBe('no-store');
    expect(enrollment.json().data).toEqual({
      secret: 'A'.repeat(32),
      otpauth_uri: 'otpauth://totp/AIHUB:test',
    });

    const confirmation = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrollment/confirm',
      headers,
      payload: { code: '123456' },
    });
    expect(confirmation.statusCode).toBe(200);
    expect(confirmation.headers['cache-control']).toBe('no-store');
    expect(confirmation.json().data.recovery_codes).toEqual([
      'ABCD-EFGH-IJKL-MNOP',
    ]);

    const removal = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/mfa',
      headers,
      payload: { password: 'correct horse battery' },
    });
    expect(removal.statusCode).toBe(204);
    expect(removal.headers['cache-control']).toBe('no-store');
  });

  it('requires a Bearer user access token for the current account', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_USER_ACCESS_TOKEN_REQUIRED');
  });

  it('registers and acknowledges first and repeated verification through HTTP', async () => {
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
        email_delivery_status: 'queued',
      },
      meta: { request_id: expect.stringMatching(/^req_/) },
    });
    expect(register.payload).not.toContain('argon2');
    const token = issuedVerificationToken();

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(verify.statusCode).toBe(204);
    expect(verify.payload).toBe('');
    expect(verify.headers['set-cookie']).toBeUndefined();

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token },
    });
    expect(replay.statusCode).toBe(204);
    expect(replay.payload).toBe('');
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  describe('Verification Sign-in', () => {
    const binding = 'b'.repeat(43);

    async function registerBound(): Promise<string> {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: EMAIL,
          username: 'person_01',
          password: 'correct horse battery',
          browser_binding: binding,
        },
      });
      return issuedVerificationToken();
    }

    it('stores only the hash of the binding sent with register and resend', async () => {
      const token = await registerBound();
      await app.inject({
        method: 'POST',
        url: '/v1/auth/resend-verification',
        headers: { 'content-type': 'application/json' },
        payload: { email: EMAIL, browser_binding: binding },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });

      const stored = [...state.verificationTokens.values()];
      expect(stored).toHaveLength(2);
      for (const persisted of stored) {
        expect(persisted.browserBindingHash).toBe(`hash:${binding}`);
      }
      expect(JSON.stringify(stored)).not.toContain(`"${binding}"`);
    });

    it('signs in the signup browser once when the binding matches', async () => {
      const token = await registerBound();

      const first = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });

      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.json()).toEqual({
        data: {
          access_token: 'ey.fake.access',
          token_type: 'Bearer',
          expires_in: 900,
        },
        meta: { request_id: expect.stringMatching(/^req_/) },
      });
      const setCookie = first.headers['set-cookie'];
      expect(Array.isArray(setCookie) ? setCookie : [setCookie]).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^__Host-aihub_refresh=.+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
          ),
        ]),
      );
      expect(first.payload).not.toContain(binding);
      expect(state.refreshTokens.size).toBe(1);

      const replay = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, browser_binding: binding },
      });
      expect(replay.statusCode).toBe(204);
      expect(replay.headers['set-cookie']).toBeUndefined();
      expect(state.refreshTokens.size).toBe(1);
    });

    it.each([
      ['no binding', {}],
      ['another browser binding', { browser_binding: 'c'.repeat(43) }],
    ])('only verifies with %s', async (_name, extra) => {
      const token = await registerBound();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers: { 'content-type': 'application/json' },
        payload: { token, ...extra },
      });

      expect(response.statusCode).toBe(204);
      expect(response.payload).toBe('');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(state.refreshTokens.size).toBe(0);
    });

    it.each([
      [
        '/v1/auth/register',
        { email: 'bound@example.com', username: 'bound_01' },
      ],
      ['/v1/auth/resend-verification', { email: 'bound@example.com' }],
    ])('rejects a malformed binding on %s', async (url, body) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { ...body, browser_binding: 'too-short' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    });
  });

  const passwordBoundaryRequests = [
    {
      name: 'register',
      url: '/v1/auth/register',
      body: { email: EMAIL, username: 'person_01' },
      validStatus: 201,
    },
    {
      name: 'login',
      url: '/v1/auth/login',
      body: { email: EMAIL },
      validStatus: 200,
    },
    {
      name: 'reset-password',
      url: '/v1/auth/reset-password',
      body: {},
      validStatus: 204,
    },
  ];

  const createPasswordBoundaryCases = (lengths: readonly number[]) =>
    passwordBoundaryRequests.flatMap((request) =>
      lengths.flatMap((length) =>
        ['a', '😀'].map((character) => ({
          request,
          length,
          password: character.repeat(length),
        })),
      ),
    );

  const validPasswordBoundaryCases = createPasswordBoundaryCases([12, 128]);
  const invalidPasswordBoundaryCases = createPasswordBoundaryCases([11, 129]);

  it.each(validPasswordBoundaryCases)(
    '$request.name accepts a $length-code-point password',
    async ({ request, password }) => {
      if (request.name !== 'register') {
        seedActiveAccount();
      }
      const body = {
        ...request.body,
        ...(request.name === 'reset-password'
          ? { token: await openResetToken() }
          : {}),
        password,
      };

      const response = await app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });

      expect(response.statusCode).toBe(request.validStatus);
    },
  );

  it.each(invalidPasswordBoundaryCases)(
    '$request.name rejects a $length-code-point password generically',
    async ({ request, password }) => {
      const response = await app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'content-type': 'application/json' },
        payload: { ...request.body, password },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request failed validation',
          request_id: expect.stringMatching(/^req_/),
          retryable: false,
        },
      });
    },
  );

  it('keeps an identity conflict distinct from an invalid password length', async () => {
    seedActiveAccount();

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        username: 'person_01',
        password: 'a'.repeat(12),
      },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        username: 'person_01',
        password: 'a'.repeat(11),
      },
    });

    expect([
      conflict.statusCode,
      conflict.json().error.code,
      invalid.statusCode,
      invalid.json().error.code,
    ]).toEqual([409, 'AUTH_IDENTITY_UNAVAILABLE', 400, 'INVALID_REQUEST']);
    expect(state.accounts.size).toBe(1);
  });

  it('keeps malformed input generic', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(state.accounts.size).toBe(0);
    expect(state.emailDeliveryRequests).toHaveLength(0);
  });

  it('returns the generic invalid-token error over HTTP', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: 'invalid-token' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'AUTH_VERIFICATION_TOKEN_INVALID',
      message: 'Verification token is invalid',
    });
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
    expect(state.verificationTokens.size).toBe(0);
  });

  it.each([
    ['unknown', false],
    ['known', true],
  ])(
    'returns the same recovery envelope for a %s account',
    async (_label, eligible) => {
      if (eligible) {
        seedActiveAccount();
      }

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/forgot-password',
        headers: { 'content-type': 'application/json' },
        payload: { email: ' Person@Example.com ' },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        data: { message: RECOVERY_MESSAGE },
        meta: { request_id: expect.stringMatching(/^req_/) },
      });
      expect(response.payload).not.toContain('reset-token');
    },
  );

  it('queues reset instructions instead of sending them in the request path', async () => {
    seedActiveAccount();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: { email: ' Person@Example.com ' },
    });

    expect(response.statusCode).toBe(202);
    expect(state.emailDeliveryRequests).toHaveLength(1);
    expect(sealed(state.emailDeliveryRequests[0])).toMatchObject({
      email: EMAIL,
      token: 'reset-token-1',
    });
    expect(response.payload).not.toContain('reset-token');
  });

  it('resets the password with a bodyless no-store response and clears refresh state', async () => {
    seedActiveAccount();
    const token = await openResetToken();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: {
        token,
        password: 'new password that works',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('changes the password and revokes every existing refresh session', async () => {
    hasher.verifyByHash = true;
    seedAccount(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: await hasher.hash('old password'),
    });
    const token = await openResetToken();

    const firstLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    const secondLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    expect(firstLogin.statusCode).toBe(200);
    expect(secondLogin.statusCode).toBe(200);
    const firstCookie = cookieOf(firstLogin);
    const secondCookie = cookieOf(secondLogin);

    const reset = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: { token, password: 'new password that works' },
    });
    expect(reset.statusCode).toBe(204);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'old password' },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'new password that works' },
    });
    expect(newPassword.statusCode).toBe(200);

    const firstRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: firstCookie },
    });
    const secondRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: secondCookie },
    });
    expect(firstRefresh.statusCode).toBe(401);
    expect(secondRefresh.statusCode).toBe(401);
  });

  it('maps a replayed reset token to the public invalid-token error', async () => {
    seedActiveAccount();
    const token = await openResetToken();
    const payload = {
      method: 'POST' as const,
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/json' },
    };

    const first = await app.inject({
      ...payload,
      payload: { token, password: 'new password that works' },
    });
    expect(first.statusCode).toBe(204);

    const replay = await app.inject({
      ...payload,
      payload: { token, password: 'another password here' },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID' }),
    );
  });

  it('logs in through the real HTTP stack with a narrow no-store response', async () => {
    seedActiveAccount();
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

  it('returns MFA_REQUIRED without setting a refresh cookie or creating a session', async () => {
    seedActiveAccount();
    mfa.loginResult = { kind: 'required' };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct horse battery' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data).toEqual({ status: 'MFA_REQUIRED' });
    expect(state.refreshTokens.size).toBe(0);
  });

  it('keeps unknown and inactive login failures generic', async () => {
    hasher.result = false;

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com', password: 'wrong password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toEqual(
      expect.objectContaining({ code: 'AUTH_CREDENTIALS_INVALID' }),
    );
    expect(unknown.payload).not.toContain('nobody@example.com');

    seedActiveAccount();
    const pending = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct horse battery' },
    });
    expect(pending.statusCode).toBe(401);
    expect(pending.payload).not.toContain('pending_verification');
  });

  it('rejects extra login fields at the boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: EMAIL,
        password: 'correct horse battery',
        remember_me: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rotates the refresh cookie and revokes a reused family', async () => {
    seedActiveAccount();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

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
    const rotatedCookie = cookieOf(refresh);
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
    seedActiveAccount();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

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
    seedActiveAccount();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);
    const rawToken = loginCookie.slice(loginCookie.indexOf('=') + 1);
    const tokenHash = refreshTokenIssuer.hash(rawToken);
    const stored = state.refreshTokens.get(tokenHash);
    if (stored === undefined) {
      throw new Error('refresh session was not persisted');
    }
    state.refreshTokens.set(tokenHash, { ...stored, expiresAt: new Date(0) });

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
      payload: { email: EMAIL, password: 'correct password' },
    });
    const activeCookie = cookieOf(activeLogin);
    account().status = 'disabled';

    const disabled = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: activeCookie },
    });
    expect(disabled.statusCode).toBe(401);
  });

  it('fails closed without a cookie when durable session persistence fails', async () => {
    seedActiveAccount();
    refreshSessions.failCreateRefreshSession = true;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    refreshSessions.failCreateRefreshSession = false;

    expect(response.statusCode).toBe(500);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.payload).not.toContain('ey.fake.access');
    expect(state.refreshTokens.size).toBe(0);
  });

  it('logs out idempotently and only revokes the selected login family', async () => {
    seedActiveAccount();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const firstCookie = cookieOf(first);
    const secondCookie = cookieOf(second);

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

    seedActiveAccount();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const validCookie = cookieOf(login);

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
    seedActiveAccount();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: EMAIL, password: 'correct password' },
    });
    const loginCookie = cookieOf(login);

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
