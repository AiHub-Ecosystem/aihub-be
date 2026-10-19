import fastifyCookie from '@fastify/cookie';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { createAppFastifyProxyOptions } from '@/app-fastify-proxy-options';
import { AppModule } from '@/app.module';
import { generateRequestId } from '@/common/request-context/request-id';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import {
  EMAIL_PAYLOAD_CIPHER,
  type EmailPayloadCipherPort,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
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
  type IssuedPasswordResetToken,
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
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryPasswordResetTokenAdapter } from '@/modules/auth/testing/in-memory-password-reset-token.adapter';
import { InMemoryRefreshSessionAdapter } from '@/modules/auth/testing/in-memory-refresh-session.adapter';
import { InMemoryUserAccountAdapter } from '@/modules/auth/testing/in-memory-user-account.adapter';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { VERIFICATION_TOKEN_REPOSITORY } from '@/modules/auth/verification/application/verification-token-repository.port';
import {
  type IssuedVerificationToken,
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from '@/modules/auth/verification/application/verification-token.port';
import { REFRESH_SESSION_REPOSITORY } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';
import {
  type IssuedRefreshToken,
  REFRESH_TOKEN_ISSUER,
  type RefreshTokenIssuerPort,
} from '@/modules/auth/web-sessions/application/refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

export const USER_ID = 'usr_01J00000000000000000000000';
export const EMAIL = 'person@example.com';
export const RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

export class PayloadCipherFake implements EmailPayloadCipherPort {
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

export class HasherFake implements PasswordHasherPort {
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

export class TokenFake implements VerificationTokenPort {
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

export class PasswordResetTokenFake implements PasswordResetTokenPort {
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

export class LimiterFake implements AuthRateLimiterPort {
  allowed = true;
  calls: Parameters<AuthRateLimiterPort['consume']>[0][] = [];
  blockedKeys = new Set<string>();
  private readonly counters = new Map<
    string,
    { readonly expiresAt: number; count: number }
  >();

  async check(): Promise<{ allowed: boolean }> {
    return { allowed: this.allowed };
  }

  async consume(
    input: Parameters<AuthRateLimiterPort['consume']>[0],
  ): Promise<{ readonly allowed: boolean; readonly retryAfterMs?: number }> {
    this.calls.push(input);
    if (!this.allowed || this.blockedKeys.has(`${input.scope}:${input.key}`)) {
      return { allowed: false };
    }
    const key = `${input.scope}:${input.key}`;
    const now = Date.now();
    const current = this.counters.get(key);
    const counter =
      current === undefined || current.expiresAt <= now
        ? { count: 0, expiresAt: now + input.windowMs }
        : current;
    counter.count += 1;
    this.counters.set(key, counter);
    return counter.count <= input.limit
      ? { allowed: true }
      : {
          allowed: false,
          retryAfterMs: Math.max(0, counter.expiresAt - now),
        };
  }

  reset(): void {
    this.allowed = true;
    this.calls = [];
    this.blockedKeys.clear();
    this.counters.clear();
  }
}

export class MfaFake implements AuthMfaServicePort {
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

export class AccessTokenIssuerFake implements UserAccessTokenIssuerPort {
  fail = false;

  async issue(): Promise<{ token: string; expiresIn: number }> {
    if (this.fail) {
      throw new Error('access token issuer unavailable');
    }
    return { token: 'ey.fake.access', expiresIn: 900 };
  }
}

export class RefreshTokenIssuerFake implements RefreshTokenIssuerPort {
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

export interface LocalAuthTestContext {
  app: NestFastifyApplication;
  state: InMemoryAuthState;
  userAccounts: InMemoryUserAccountAdapter;
  verificationTokens: InMemoryVerificationTokenAdapter;
  passwordResetTokens: InMemoryPasswordResetTokenAdapter;
  refreshSessions: InMemoryRefreshSessionAdapter;
  cipher: PayloadCipherFake;
  hasher: HasherFake;
  limiter: LimiterFake;
  tokenIssuer: TokenFake;
  passwordResetTokenIssuer: PasswordResetTokenFake;
  refreshTokenIssuer: RefreshTokenIssuerFake;
  accessTokenIssuer: AccessTokenIssuerFake;
  mfa: MfaFake;
  reset: () => void;
}

export async function createLocalAuthTestContext(): Promise<LocalAuthTestContext> {
  const state = createInMemoryAuthState();
  const userAccounts = new InMemoryUserAccountAdapter(state);
  const verificationTokens = new InMemoryVerificationTokenAdapter(state);
  const passwordResetTokens = new InMemoryPasswordResetTokenAdapter(state);
  const refreshSessions = new InMemoryRefreshSessionAdapter(state);
  const cipher = new PayloadCipherFake();
  const hasher = new HasherFake();
  const limiter = new LimiterFake();
  const tokenIssuer = new TokenFake();
  const passwordResetTokenIssuer = new PasswordResetTokenFake();
  const refreshTokenIssuer = new RefreshTokenIssuerFake();
  const accessTokenIssuer = new AccessTokenIssuerFake();
  const mfa = new MfaFake();
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

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      ...createAppFastifyProxyOptions('172.16.7.1'),
      genReqId: () => generateRequestId(),
    }),
  );
  const fastify = app.getHttpAdapter().getInstance();
  await Reflect.apply(fastify.register, fastify, [fastifyCookie]);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const reset = (): void => {
    state.reset();
    hasher.result = true;
    hasher.verifyByHash = false;
    limiter.reset();
    accessTokenIssuer.fail = false;
    refreshSessions.failCreateRefreshSession = false;
    refreshSessions.failFindRefreshToken = false;
    tokenIssuer.reset();
    mfa.loginResult = { kind: 'none' };
    passwordResetTokenIssuer.reset();
    refreshTokenIssuer.reset();
  };

  return {
    app,
    state,
    userAccounts,
    verificationTokens,
    passwordResetTokens,
    refreshSessions,
    cipher,
    hasher,
    limiter,
    tokenIssuer,
    passwordResetTokenIssuer,
    refreshTokenIssuer,
    accessTokenIssuer,
    mfa,
    reset,
  };
}
