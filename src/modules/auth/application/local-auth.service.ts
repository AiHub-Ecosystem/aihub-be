import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '../../../common/errors/app-error';
import { invalidRequest } from '../../../common/errors/invalid-request';
import {
  type NormalizedRegistration,
  type RegistrationInput,
  normalizeEmail,
  normalizeLogin,
  normalizeRegistration,
} from '../domain/local-auth';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './auth-rate-limiter.port';
import { EMAIL_SENDER, type EmailSenderPort } from './email-sender.port';
import {
  AuthIdentityConflictError,
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from './local-auth-repository.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from './password-hasher.port';
import {
  REFRESH_TOKEN_ISSUER,
  type RefreshTokenIssuerPort,
} from './refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  type UserAccessTokenIssuerPort,
} from './user-access-token.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from './verification-token.port';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_IP_LIMIT = 20;
const LOGIN_IP_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 5;
const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000;
const REFRESH_IP_LIMIT = 20;
const REFRESH_IP_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_LIMIT = 5;
const REFRESH_TOKEN_WINDOW_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$SoHl8YUBzXgiAZ4xlgNZyg$qwZIFOa2OcIOgiHLRYImWLsza4k9/T4ZZvvhiWrD41k';

export interface RegisteredLocalAccount {
  readonly email: string;
  readonly username: string;
  readonly status: 'pending_verification';
}

export interface LocalAuthServiceClock {
  now(): Date;
}

export const AUTH_CLOCK = Symbol('AUTH_CLOCK');

function invalidRefreshToken(): AppError {
  return new AppError({
    code: 'AUTH_REFRESH_TOKEN_INVALID',
    message: 'Refresh token is invalid',
    retryable: false,
  });
}

@Injectable()
export class LocalAuthService {
  private readonly clock: LocalAuthServiceClock;

  constructor(
    @Inject(LOCAL_AUTH_REPOSITORY)
    private readonly repository: LocalAuthRepositoryPort,
    @Inject(PASSWORD_HASHER)
    private readonly passwordHasher: PasswordHasherPort,
    @Inject(VERIFICATION_TOKEN)
    private readonly tokenIssuer: VerificationTokenPort,
    @Inject(EMAIL_SENDER)
    private readonly emailSender: EmailSenderPort,
    @Inject(AUTH_RATE_LIMITER)
    private readonly rateLimiter: AuthRateLimiterPort,
    @Inject(USER_ACCESS_TOKEN_ISSUER)
    private readonly accessTokenIssuer: UserAccessTokenIssuerPort,
    @Inject(REFRESH_TOKEN_ISSUER)
    private readonly refreshTokenIssuer: RefreshTokenIssuerPort,
    @Optional()
    @Inject(AUTH_CLOCK)
    clock?: LocalAuthServiceClock,
  ) {
    this.clock = clock ?? { now: () => new Date() };
  }

  async register(
    input: RegistrationInput,
    ip: string,
  ): Promise<RegisteredLocalAccount> {
    let normalized: NormalizedRegistration;
    try {
      normalized = normalizeRegistration(input);
    } catch (error) {
      throw invalidRequest(error);
    }

    await this.enforceRateLimits([
      {
        scope: 'register_ip',
        key: ip,
        limit: 5,
        windowMs: 15 * 60 * 1000,
      },
      {
        scope: 'register_email',
        key: normalized.email,
        limit: 3,
        windowMs: VERIFICATION_TTL_MS,
      },
    ]);

    const now = this.clock.now();
    const issued = this.tokenIssuer.issue(now);
    const passwordHash = await this.passwordHasher.hash(normalized.password);

    try {
      await this.repository.register({
        email: normalized.email,
        username: normalized.username,
        passwordHash,
        tokenId: issued.id,
        tokenHash: issued.hash,
        tokenExpiresAt: issued.expiresAt,
        now,
      });
    } catch (error) {
      if (error instanceof AuthIdentityConflictError) {
        throw new AppError({
          code: 'AUTH_IDENTITY_UNAVAILABLE',
          message: 'Email or username is unavailable',
          retryable: false,
        });
      }
      throw error;
    }

    try {
      await this.emailSender.sendVerificationEmail({
        email: normalized.email,
        token: issued.raw,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      throw new AppError({
        code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
        message: 'Email delivery is temporarily unavailable',
        retryable: true,
        cause: error,
      });
    }

    return {
      email: normalized.email,
      username: normalized.username,
      status: 'pending_verification',
    };
  }

  async verify(token: string, ip: string): Promise<void> {
    await this.enforceRateLimits([
      { scope: 'verify_ip', key: ip, limit: 10, windowMs: 5 * 60 * 1000 },
    ]);

    const valid = await this.repository.consumeVerificationToken({
      tokenHash: this.tokenIssuer.hash(token),
      now: this.clock.now(),
    });
    if (!valid) {
      throw new AppError({
        code: 'AUTH_VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid',
        retryable: false,
      });
    }
  }

  async resend(email: string, ip: string): Promise<void> {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch (error) {
      throw invalidRequest(error);
    }

    await this.enforceRateLimits([
      {
        scope: 'resend_ip',
        key: ip,
        limit: 3,
        windowMs: 15 * 60 * 1000,
      },
      {
        scope: 'resend_email',
        key: normalizedEmail,
        limit: 3,
        windowMs: VERIFICATION_TTL_MS,
      },
    ]);

    const now = this.clock.now();
    const issued = this.tokenIssuer.issue(now);
    const target = await this.repository.rotateVerificationToken({
      email: normalizedEmail,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      now,
    });
    if (target === undefined) {
      return;
    }

    // Keep the route generic: a provider failure must not reveal that the
    // address belongs to an account. Registration exposes a delivery failure
    // because it already creates a new account and has no enumeration value.
    try {
      await this.emailSender.sendVerificationEmail({
        email: target.email,
        token: issued.raw,
        expiresAt: issued.expiresAt,
      });
    } catch {
      // The next generic resend can recover delivery without exposing state.
    }
  }

  async login(
    input: { readonly email: string; readonly password: string },
    ip: string,
  ): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly refreshToken: string;
  }> {
    let normalized: { readonly email: string; readonly password: string };
    try {
      normalized = normalizeLogin(input);
    } catch (error) {
      throw invalidRequest(error);
    }

    const identity = await this.repository.findLoginIdentityByEmail(
      normalized.email,
    );
    const passwordHash = identity?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await this.passwordHasher.verify(
      normalized.password,
      passwordHash,
    );

    if (
      identity === undefined ||
      !passwordMatches ||
      identity.status !== 'active'
    ) {
      await this.enforceRateLimits([
        {
          scope: 'login_ip',
          key: ip,
          limit: LOGIN_IP_LIMIT,
          windowMs: LOGIN_IP_WINDOW_MS,
        },
        {
          scope: 'login_email',
          key: normalized.email,
          limit: LOGIN_EMAIL_LIMIT,
          windowMs: LOGIN_EMAIL_WINDOW_MS,
        },
      ]);
      throw new AppError({
        code: 'AUTH_CREDENTIALS_INVALID',
        message: 'Email or password is invalid',
        retryable: false,
      });
    }

    const now = this.clock.now();
    const accessToken = await this.accessTokenIssuer.issue(identity.userId);
    const refreshToken = this.refreshTokenIssuer.issue(now);
    await this.repository.createRefreshSession({
      userId: identity.userId,
      token: refreshToken,
      issuedAt: now,
    });
    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken: refreshToken.raw,
    };
  }

  async refresh(
    rawToken: string | undefined,
    ip: string,
  ): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly refreshToken: string;
  }> {
    if (rawToken === undefined || rawToken.length === 0) {
      await this.enforceRefreshFailureLimits(ip);
      throw invalidRefreshToken();
    }

    const tokenHash = this.refreshTokenIssuer.hash(rawToken);
    const current = await this.repository.findRefreshTokenByHash(tokenHash);
    if (current === undefined) {
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    const now = this.clock.now();
    const successor = this.refreshTokenIssuer.issue(now, current.familyId);
    const rotation = await this.repository.rotateRefreshToken({
      tokenId: current.tokenId,
      tokenHash,
      successor,
      now,
    });
    if (rotation.kind !== 'rotated') {
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    const accessToken = await this.accessTokenIssuer.issue(rotation.userId);
    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken: successor.raw,
    };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken === undefined || rawToken.length === 0) {
      return;
    }

    await this.repository.revokeRefreshFamilyByTokenHash({
      tokenHash: this.refreshTokenIssuer.hash(rawToken),
      now: this.clock.now(),
    });
  }

  private async enforceRateLimits(
    limits: ReadonlyArray<{
      readonly scope: Parameters<AuthRateLimiterPort['consume']>[0]['scope'];
      readonly key: string;
      readonly limit: number;
      readonly windowMs: number;
    }>,
  ): Promise<void> {
    for (const limit of limits) {
      const result = await this.rateLimiter.consume(limit);
      if (!result.allowed) {
        throw new AppError({
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          retryable: true,
          ...(result.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: result.retryAfterMs }),
        });
      }
    }
  }

  private async enforceRefreshFailureLimits(
    ip: string,
    tokenHash?: string,
  ): Promise<void> {
    await this.enforceRateLimits([
      {
        scope: 'refresh_ip',
        key: ip,
        limit: REFRESH_IP_LIMIT,
        windowMs: REFRESH_IP_WINDOW_MS,
      },
      ...(tokenHash === undefined
        ? []
        : [
            {
              scope: 'refresh_token' as const,
              key: tokenHash,
              limit: REFRESH_TOKEN_LIMIT,
              windowMs: REFRESH_TOKEN_WINDOW_MS,
            },
          ]),
    ]);
  }
}
