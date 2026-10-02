import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { ResetPasswordRequest } from '@/contracts/auth/local-auth';
import {
  type NormalizedRegistration,
  type RegistrationInput,
  normalizeEmail,
  normalizeLogin,
  normalizeRegistration,
  validatePassword,
} from '@/modules/auth/domain/local-auth';
import { AuthIdentityConflictError } from './auth-identity-conflict.error';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './auth-rate-limiter.port';
import { EMAIL_SENDER, type EmailSenderPort } from './email-sender.port';
import {
  type IssuedSession,
  RefreshRotationCommittedError,
} from './local-auth-service.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from './password-hasher.port';
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepositoryPort,
} from './password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from './password-reset-token.port';
import {
  REFRESH_SESSION_REPOSITORY,
  type RefreshSessionRepositoryPort,
} from './refresh-session-repository.port';
import {
  type IssuedRefreshToken,
  REFRESH_TOKEN_ISSUER,
  type RefreshTokenIssuerPort,
} from './refresh-token.port';
import {
  type IssuedUserAccessToken,
  USER_ACCESS_TOKEN_ISSUER,
  type UserAccessTokenIssuerPort,
} from './user-access-token.port';
import {
  USER_ACCOUNT_REPOSITORY,
  type UserAccountRepositoryPort,
} from './user-account.port';
import {
  VERIFICATION_TOKEN_REPOSITORY,
  type VerificationTokenRepositoryPort,
} from './verification-token-repository.port';
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
const FORGOT_IP_LIMIT = 3;
const FORGOT_IP_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_EMAIL_LIMIT = 3;
const FORGOT_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESET_IP_LIMIT = 10;
const RESET_IP_WINDOW_MS = 5 * 60 * 1000;
const RESET_TOKEN_LIMIT = 5;
const RESET_TOKEN_WINDOW_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$SoHl8YUBzXgiAZ4xlgNZyg$qwZIFOa2OcIOgiHLRYImWLsza4k9/T4ZZvvhiWrD41k';
const PASSWORD_RECOVERY_MESSAGE =
  'If the account exists, reset instructions have been sent.';

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

function invalidPasswordResetToken(): AppError {
  return new AppError({
    code: 'AUTH_PASSWORD_RESET_TOKEN_INVALID',
    message: 'Password reset token is invalid',
    retryable: false,
  });
}

@Injectable()
export class LocalAuthService {
  private readonly clock: LocalAuthServiceClock;

  constructor(
    @Inject(USER_ACCOUNT_REPOSITORY)
    private readonly userAccounts: UserAccountRepositoryPort,
    @Inject(VERIFICATION_TOKEN_REPOSITORY)
    private readonly verificationTokens: VerificationTokenRepositoryPort,
    @Inject(PASSWORD_RESET_TOKEN_REPOSITORY)
    private readonly passwordResetTokens: PasswordResetTokenRepositoryPort,
    @Inject(REFRESH_SESSION_REPOSITORY)
    private readonly refreshSessions: RefreshSessionRepositoryPort,
    @Inject(PASSWORD_HASHER)
    private readonly passwordHasher: PasswordHasherPort,
    @Inject(VERIFICATION_TOKEN)
    private readonly tokenIssuer: VerificationTokenPort,
    @Inject(PASSWORD_RESET_TOKEN)
    private readonly passwordResetTokenIssuer: PasswordResetTokenPort,
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
    browserBinding?: string,
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
      await this.userAccounts.register({
        email: normalized.email,
        username: normalized.username,
        passwordHash,
        tokenId: issued.id,
        tokenHash: issued.hash,
        tokenExpiresAt: issued.expiresAt,
        ...this.bindingHash(browserBinding),
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

  async verify(
    token: string,
    ip: string,
    browserBinding?: string,
  ): Promise<IssuedSession | undefined> {
    await this.enforceRateLimits([
      { scope: 'verify_ip', key: ip, limit: 10, windowMs: 5 * 60 * 1000 },
    ]);

    const now = this.clock.now();
    // Pre-issued so Verification Sign-in commits the one-time claim and its
    // Refresh Session together (ADR-0054). A write failure rolls the claim
    // back, leaving the sign-in available while the token is unexpired.
    const refreshToken = this.refreshTokenIssuer.issue(now);
    const outcome = await this.verificationTokens.consumeVerificationToken({
      tokenHash: this.tokenIssuer.hash(token),
      ...this.bindingHash(browserBinding),
      signInSession: { token: refreshToken, issuedAt: now },
      now,
    });
    if (outcome.kind === 'invalid') {
      throw new AppError({
        code: 'AUTH_VERIFICATION_TOKEN_INVALID',
        message: 'Verification token is invalid',
        retryable: false,
      });
    }
    if (outcome.kind === 'verified') {
      return undefined;
    }

    return this.toIssuedSession(outcome.userId, refreshToken);
  }

  async resend(
    email: string,
    ip: string,
    browserBinding?: string,
  ): Promise<void> {
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
    const target = await this.verificationTokens.rotateVerificationToken({
      email: normalizedEmail,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      ...this.bindingHash(browserBinding),
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

  async forgotPassword(
    input: { readonly email: string },
    ip: string,
  ): Promise<{ readonly message: string }> {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(input.email);
    } catch (error) {
      throw invalidRequest(error);
    }

    await this.enforceRateLimits([
      {
        scope: 'forgot_ip',
        key: ip,
        limit: FORGOT_IP_LIMIT,
        windowMs: FORGOT_IP_WINDOW_MS,
      },
      {
        scope: 'forgot_email',
        key: normalizedEmail,
        limit: FORGOT_EMAIL_LIMIT,
        windowMs: FORGOT_EMAIL_WINDOW_MS,
      },
    ]);

    const now = this.clock.now();
    const issued = this.passwordResetTokenIssuer.issue(now);
    const target = await this.passwordResetTokens.issuePasswordResetToken({
      email: normalizedEmail,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      now,
    });

    if (target !== undefined) {
      try {
        await this.emailSender.sendPasswordResetEmail({
          email: target.email,
          token: issued.raw,
          expiresAt: issued.expiresAt,
        });
      } catch {
        // Keep the public recovery result generic. A later request supersedes
        // this token, while a late provider delivery can still succeed.
      }
    }

    return { message: PASSWORD_RECOVERY_MESSAGE };
  }

  async resetPassword(input: ResetPasswordRequest, ip: string): Promise<void> {
    let password: string;
    try {
      password = validatePassword(input.password);
    } catch (error) {
      throw invalidRequest(error);
    }

    const tokenHash = this.passwordResetTokenIssuer.hash(input.token);
    const tokenCheck = await this.passwordResetTokens.checkPasswordResetToken({
      tokenHash,
      now: this.clock.now(),
    });
    if (tokenCheck.kind === 'invalid') {
      await this.enforceResetFailureLimits(ip, tokenHash);
      throw invalidPasswordResetToken();
    }

    const passwordHash = await this.passwordHasher.hash(password);
    const result = await this.passwordResetTokens.consumePasswordReset({
      tokenHash,
      passwordHash,
      now: this.clock.now(),
    });

    if (result.kind === 'invalid') {
      await this.enforceResetFailureLimits(ip, tokenHash);
      throw invalidPasswordResetToken();
    }
  }

  async login(
    input: { readonly email: string; readonly password: string },
    ip: string,
  ): Promise<IssuedSession> {
    let normalized: { readonly email: string; readonly password: string };
    try {
      normalized = normalizeLogin(input);
    } catch (error) {
      throw invalidRequest(error);
    }

    const identity = await this.userAccounts.findLoginIdentityByEmail(
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

    return this.startLoginSession(identity.userId, this.clock.now());
  }

  /**
   * Login mints both tokens and then persists the Refresh Session. The access
   * token is minted first, so a session write failure reaches the client
   * without an access token it could not pair with a cookie.
   */
  private async startLoginSession(
    userId: string,
    now: Date,
  ): Promise<IssuedSession> {
    const refreshToken = this.refreshTokenIssuer.issue(now);
    const session = await this.toIssuedSession(userId, refreshToken);
    await this.refreshSessions.createRefreshSession({
      userId,
      token: refreshToken,
      issuedAt: now,
    });
    return session;
  }

  /**
   * The one way a session reaches a client. Verification Sign-in passes the
   * Refresh Session its claim already stored; login stores it afterwards.
   */
  private async toIssuedSession(
    userId: string,
    refreshToken: IssuedRefreshToken,
  ): Promise<IssuedSession> {
    const accessToken: IssuedUserAccessToken =
      await this.accessTokenIssuer.issue(userId);
    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      refreshToken: refreshToken.raw,
    };
  }

  /** The Signup Browser Binding is stored and compared only as a hash. */
  private bindingHash(browserBinding: string | undefined): {
    readonly browserBindingHash?: string;
  } {
    return browserBinding === undefined
      ? {}
      : { browserBindingHash: this.tokenIssuer.hash(browserBinding) };
  }

  async refresh(
    rawToken: string | undefined,
    ip: string,
  ): Promise<IssuedSession> {
    if (rawToken === undefined || rawToken.length === 0) {
      await this.enforceRefreshFailureLimits(ip);
      throw invalidRefreshToken();
    }

    const tokenHash = this.refreshTokenIssuer.hash(rawToken);
    const current =
      await this.refreshSessions.findRefreshTokenByHash(tokenHash);
    if (current === undefined) {
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    const now = this.clock.now();
    const successor = this.refreshTokenIssuer.issue(now, current.familyId);
    const rotation = await this.refreshSessions.rotateRefreshToken({
      tokenId: current.tokenId,
      tokenHash,
      successor,
      now,
    });
    if (rotation.kind !== 'rotated') {
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    let accessToken: IssuedUserAccessToken;
    try {
      accessToken = await this.accessTokenIssuer.issue(rotation.userId);
    } catch {
      throw new RefreshRotationCommittedError();
    }
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

    await this.refreshSessions.revokeRefreshFamilyByTokenHash({
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

  private async enforceResetFailureLimits(
    ip: string,
    tokenHash: string,
  ): Promise<void> {
    await this.enforceRateLimits([
      {
        scope: 'reset_ip',
        key: ip,
        limit: RESET_IP_LIMIT,
        windowMs: RESET_IP_WINDOW_MS,
      },
      {
        scope: 'reset_token',
        key: tokenHash,
        limit: RESET_TOKEN_LIMIT,
        windowMs: RESET_TOKEN_WINDOW_MS,
      },
    ]);
  }
}
