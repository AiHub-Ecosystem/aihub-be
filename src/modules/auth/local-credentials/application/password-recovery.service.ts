import { invalidRequest } from '@/common/errors/invalid-request';
import type { ResetPasswordRequest } from '@/contracts/auth/local-auth';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import {
  normalizeEmail,
  validatePassword,
} from '@/modules/auth/local-credentials/public/local-auth';
import type { PasswordResetTokenRepositoryPort } from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import type { PasswordResetTokenPort } from '@/modules/auth/password-reset/application/password-reset-token.port';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { enforceAuthRateLimits } from '@/modules/auth/rate-limit/public/auth-rate-limit';
import type { AuthClock } from '@/modules/auth/shared/application/auth-clock';
import { invalidPasswordResetToken } from '@/modules/auth/shared/application/local-auth-errors';
import {
  AUTH_EMAIL_REQUEST_LIMIT,
  emailDeliveryRequest,
} from './auth-email-request';
import type { PasswordHasherPort } from './password-hasher.port';
import type { PasswordRecoveryPort } from './password-recovery.port';

const PASSWORD_RECOVERY_RATE_LIMITS = {
  forgotPassword: {
    ip: { scope: 'forgot_ip', limit: 3, windowMs: 15 * 60 * 1000 },
  },
  resetPassword: {
    ip: { scope: 'reset_ip', limit: 10, windowMs: 5 * 60 * 1000 },
    token: { scope: 'reset_token', limit: 5, windowMs: 15 * 60 * 1000 },
  },
} as const;
const PASSWORD_RECOVERY_MESSAGE =
  'If the account exists and is eligible, AIHUB has accepted a request to send password reset instructions.';

/** Forgot-password and reset-password, built by the auth composition root. */
export class PasswordRecoveryService implements PasswordRecoveryPort {
  constructor(
    private readonly passwordResetTokens: PasswordResetTokenRepositoryPort,
    private readonly passwordResetTokenIssuer: PasswordResetTokenPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly emailOutbox: EmailOutboxPort,
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly clock: AuthClock,
  ) {}

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

    return this.emailOutbox.withAdmission('password_reset_email', async () => {
      await enforceAuthRateLimits(this.rateLimiter, [
        {
          ...PASSWORD_RECOVERY_RATE_LIMITS.forgotPassword.ip,
          key: ip,
        },
        {
          ...AUTH_EMAIL_REQUEST_LIMIT,
          key: JSON.stringify([ip, normalizedEmail]),
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
        emailDelivery: emailDeliveryRequest(
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
    });
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

  private async enforceResetFailureLimits(
    ip: string,
    tokenHash: string,
  ): Promise<void> {
    await enforceAuthRateLimits(this.rateLimiter, [
      {
        ...PASSWORD_RECOVERY_RATE_LIMITS.resetPassword.ip,
        key: ip,
      },
      {
        ...PASSWORD_RECOVERY_RATE_LIMITS.resetPassword.token,
        key: tokenHash,
      },
    ]);
  }
}
