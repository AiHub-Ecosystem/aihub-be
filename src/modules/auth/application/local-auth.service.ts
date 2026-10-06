import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import type { IdMinter } from '@/common/ids/prefixed-id';
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
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import {
  type EmailDeliveryKind,
  type EmailDeliveryPayload,
  type EmailPayloadCipherPort,
  type InsertEmailDeliveryRequestInput,
} from './email-delivery-request.port';
import {
  type IssuedSession,
  RefreshRotationCommittedError,
} from './local-auth-service.port';
import { type PasswordHasherPort } from './password-hasher.port';
import { type PasswordResetTokenRepositoryPort } from './password-reset-token-repository.port';
import { type PasswordResetTokenPort } from './password-reset-token.port';
import { type RefreshSessionRepositoryPort } from './refresh-session-repository.port';
import {
  type IssuedRefreshToken,
  type RefreshTokenIssuerPort,
} from './refresh-token.port';
import {
  type IssuedUserAccessToken,
  type UserAccessTokenIssuerPort,
} from './user-access-token.port';
import { type UserAccountRepositoryPort } from './user-account.port';
import { type VerificationTokenRepositoryPort } from './verification-token-repository.port';
import { type VerificationTokenPort } from './verification-token.port';

const LOCAL_AUTH_RATE_LIMITS = {
  register: {
    ip: { scope: 'register_ip', limit: 5, windowMs: 15 * 60 * 1000 },
    email: { scope: 'register_email', limit: 3, windowMs: 24 * 60 * 60 * 1000 },
  },
  verify: {
    ip: { scope: 'verify_ip', limit: 10, windowMs: 5 * 60 * 1000 },
  },
  resend: {
    ip: { scope: 'resend_ip', limit: 3, windowMs: 15 * 60 * 1000 },
    email: { scope: 'resend_email', limit: 3, windowMs: 24 * 60 * 60 * 1000 },
  },
  login: {
    ip: { scope: 'login_ip', limit: 20, windowMs: 5 * 60 * 1000 },
    email: { scope: 'login_email', limit: 5, windowMs: 15 * 60 * 1000 },
  },
  refresh: {
    ip: { scope: 'refresh_ip', limit: 20, windowMs: 5 * 60 * 1000 },
    token: { scope: 'refresh_token', limit: 5, windowMs: 15 * 60 * 1000 },
  },
  forgotPassword: {
    ip: { scope: 'forgot_ip', limit: 3, windowMs: 15 * 60 * 1000 },
    email: { scope: 'forgot_email', limit: 3, windowMs: 24 * 60 * 60 * 1000 },
  },
  resetPassword: {
    ip: { scope: 'reset_ip', limit: 10, windowMs: 5 * 60 * 1000 },
    token: { scope: 'reset_token', limit: 5, windowMs: 15 * 60 * 1000 },
  },
} as const;
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$SoHl8YUBzXgiAZ4xlgNZyg$qwZIFOa2OcIOgiHLRYImWLsza4k9/T4ZZvvhiWrD41k';
const PASSWORD_RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

export interface RegisteredLocalAccount {
  readonly email: string;
  readonly username: string;
  readonly status: 'pending_verification';
  /** Acceptance-time only: the request is queued, not yet with the provider. */
  readonly emailDeliveryStatus: 'queued';
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

/**
 * Built by the auth module's composition root, which passes every port
 * explicitly, so this class carries no framework decorators and the clock is
 * never silently the wall clock because a binding went missing.
 */
export class LocalAuthService {
  constructor(
    private readonly userAccounts: UserAccountRepositoryPort,
    private readonly verificationTokens: VerificationTokenRepositoryPort,
    private readonly passwordResetTokens: PasswordResetTokenRepositoryPort,
    private readonly refreshSessions: RefreshSessionRepositoryPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly tokenIssuer: VerificationTokenPort,
    private readonly passwordResetTokenIssuer: PasswordResetTokenPort,
    private readonly payloadCipher: EmailPayloadCipherPort,
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly accessTokenIssuer: UserAccessTokenIssuerPort,
    private readonly refreshTokenIssuer: RefreshTokenIssuerPort,
    private readonly clock: LocalAuthServiceClock,
    private readonly newEmailDeliveryId: IdMinter,
  ) {}

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
      { ...LOCAL_AUTH_RATE_LIMITS.register.ip, key: ip },
      { ...LOCAL_AUTH_RATE_LIMITS.register.email, key: normalized.email },
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
        // Committed with the account or not at all (ADR-0074).
        emailDelivery: this.emailDeliveryRequest(
          'verification_email',
          {
            email: normalized.email,
            token: issued.raw,
            expiresAt: issued.expiresAt.toISOString(),
          },
          now,
        ),
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

    return {
      email: normalized.email,
      username: normalized.username,
      status: 'pending_verification',
      emailDeliveryStatus: 'queued',
    };
  }

  async verify(
    token: string,
    ip: string,
    browserBinding?: string,
  ): Promise<IssuedSession | undefined> {
    await this.enforceRateLimits([
      { ...LOCAL_AUTH_RATE_LIMITS.verify.ip, key: ip },
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
      { ...LOCAL_AUTH_RATE_LIMITS.resend.ip, key: ip },
      { ...LOCAL_AUTH_RATE_LIMITS.resend.email, key: normalizedEmail },
    ]);

    const now = this.clock.now();
    const issued = this.tokenIssuer.issue(now);
    // The address is already canonical here, so the request can be sealed before
    // the repository knows whether a target exists. A repository that finds no
    // target writes neither the rotation nor the request, and the route stays
    // generic either way: it must not reveal that a request was queued.
    await this.verificationTokens.rotateVerificationToken({
      email: normalizedEmail,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      ...this.bindingHash(browserBinding),
      emailDelivery: this.emailDeliveryRequest(
        'verification_email',
        {
          email: normalizedEmail,
          token: issued.raw,
          expiresAt: issued.expiresAt.toISOString(),
        },
        now,
      ),
      now,
    });
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
        ...LOCAL_AUTH_RATE_LIMITS.forgotPassword.ip,
        key: ip,
      },
      {
        ...LOCAL_AUTH_RATE_LIMITS.forgotPassword.email,
        key: normalizedEmail,
      },
    ]);

    const now = this.clock.now();
    const issued = this.passwordResetTokenIssuer.issue(now);
    // Sealed before the repository resolves the target, because the request is
    // written inside that transaction. An ineligible address yields neither the
    // token nor the request, and the reply is identical either way.
    await this.passwordResetTokens.issuePasswordResetToken({
      email: normalizedEmail,
      tokenId: issued.id,
      tokenHash: issued.hash,
      tokenExpiresAt: issued.expiresAt,
      emailDelivery: this.emailDeliveryRequest(
        'password_reset_email',
        {
          email: normalizedEmail,
          token: issued.raw,
          expiresAt: issued.expiresAt.toISOString(),
        },
        now,
      ),
      now,
    });

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
          ...LOCAL_AUTH_RATE_LIMITS.login.ip,
          key: ip,
        },
        {
          ...LOCAL_AUTH_RATE_LIMITS.login.email,
          key: normalized.email,
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

  /**
   * The durable handoff (ADR-0074). The recipient and token reach the row only
   * as authenticated ciphertext, under a key version the worker can still
   * resolve when it claims the row.
   */
  private emailDeliveryRequest(
    kind: EmailDeliveryKind,
    payload: EmailDeliveryPayload,
    now: Date,
  ): InsertEmailDeliveryRequestInput {
    return {
      id: this.newEmailDeliveryId(now),
      kind,
      payloadCiphertext: this.payloadCipher.encrypt(JSON.stringify(payload)),
      createdAt: now,
    };
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
        ...LOCAL_AUTH_RATE_LIMITS.refresh.ip,
        key: ip,
      },
      ...(tokenHash === undefined
        ? []
        : [
            {
              ...LOCAL_AUTH_RATE_LIMITS.refresh.token,
              key: tokenHash,
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
        ...LOCAL_AUTH_RATE_LIMITS.resetPassword.ip,
        key: ip,
      },
      {
        ...LOCAL_AUTH_RATE_LIMITS.resetPassword.token,
        key: tokenHash,
      },
    ]);
  }
}
