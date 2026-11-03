import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  type NormalizedRegistration,
  type RegistrationInput,
  normalizeEmail,
  normalizeRegistration,
} from '@/modules/auth/domain/local-auth';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { enforceAuthRateLimits } from '@/modules/auth/rate-limit/application/auth-rate-limit';
import type { AuthClock } from '@/modules/auth/shared/application/auth-clock';
import { AuthIdentityConflictError } from '@/modules/auth/shared/application/auth-identity-conflict.error';
import {
  proveVerificationPassword,
  verificationPasswordInvalid,
} from '@/modules/auth/verification/application/verification-password';
import {
  browserBindingHash,
  enforceVerificationRateLimit,
} from '@/modules/auth/verification/application/verification-sign-in';
import type { VerificationTokenRepositoryPort } from '@/modules/auth/verification/application/verification-token-repository.port';
import type { VerificationTokenPort } from '@/modules/auth/verification/application/verification-token.port';
import {
  AUTH_EMAIL_REQUEST_LIMIT,
  emailDeliveryRequest,
} from './auth-email-request';
import { invalidVerificationToken } from './local-auth-errors';
import type { CredentialCheckPorts } from './local-credentials';
import type {
  LocalRegistrationPort,
  RegisteredLocalAccount,
} from './local-registration.port';
import {
  type IssuedSession,
  type SessionTokenIssuers,
  issueSession,
} from './session-token-issuers';

const REGISTRATION_RATE_LIMITS = {
  register: {
    ip: { scope: 'register_ip', limit: 5, windowMs: 15 * 60 * 1000 },
  },
  resend: {
    ip: { scope: 'resend_ip', limit: 3, windowMs: 15 * 60 * 1000 },
  },
} as const;

/**
 * Registration, email verification, and Verification Sign-in. Built by the auth
 * module's composition root, which passes every collaborator explicitly, so this
 * class carries no framework decorators and the clock is never silently the
 * wall clock because a binding went missing.
 */
export class LocalRegistrationService implements LocalRegistrationPort {
  constructor(
    private readonly credentials: CredentialCheckPorts,
    private readonly verificationTokens: VerificationTokenRepositoryPort,
    private readonly tokenIssuer: VerificationTokenPort,
    private readonly emailOutbox: EmailOutboxPort,
    private readonly sessionIssuers: SessionTokenIssuers,
    private readonly clock: AuthClock,
    /** Tokens issued from now on need the registration password (ADR-0123). */
    private readonly requireVerificationPassword: boolean,
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

    return this.emailOutbox.withAdmission('verification_email', async () => {
      // Before the limits are spent: an outage is not the caller's fault.
      await enforceAuthRateLimits(this.credentials.rateLimiter, [
        { ...REGISTRATION_RATE_LIMITS.register.ip, key: ip },
        {
          ...AUTH_EMAIL_REQUEST_LIMIT,
          key: JSON.stringify([ip, normalized.email]),
        },
      ]);

      const now = this.clock.now();
      const issued = this.tokenIssuer.issue(now);
      const passwordHash = await this.credentials.passwordHasher.hash(
        normalized.password,
      );
      let emailDeliveryStatus: 'queued' | 'suppressed';

      try {
        emailDeliveryStatus = await this.credentials.userAccounts.register({
          email: normalized.email,
          username: normalized.username,
          passwordHash,
          tokenId: issued.id,
          tokenHash: issued.hash,
          tokenExpiresAt: issued.expiresAt,
          requiresPassword: this.requireVerificationPassword,
          ...browserBindingHash(this.tokenIssuer, browserBinding),
          // Committed with the account or not at all (ADR-0074).
          emailDelivery: emailDeliveryRequest(
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
        emailDeliveryStatus,
      };
    });
  }

  async verify(
    token: string,
    ip: string,
    browserBinding?: string,
    password?: string,
  ): Promise<IssuedSession | undefined> {
    await enforceVerificationRateLimit(this.credentials.rateLimiter, ip);

    const now = this.clock.now();
    // Pre-issued so Verification Sign-in commits the one-time claim and its
    // Refresh Session together (ADR-0054). A write failure rolls the claim
    // back, leaving the sign-in available while the token is unexpired.
    const refreshToken = this.sessionIssuers.refreshTokens.issue(now);
    const tokenHash = this.tokenIssuer.hash(token);
    const proof = await proveVerificationPassword(
      {
        store: this.verificationTokens,
        hasher: this.credentials.passwordHasher,
      },
      { tokenHash, password, now },
    );
    const outcome = await this.verificationTokens.consumeVerificationToken({
      tokenHash,
      ...browserBindingHash(this.tokenIssuer, browserBinding),
      ...proof,
      signInSession: { kind: 'refresh', token: refreshToken, issuedAt: now },
      now,
    });
    if (outcome.kind === 'password_required') {
      throw verificationPasswordInvalid();
    }
    if (outcome.kind === 'invalid') {
      throw invalidVerificationToken();
    }
    if (outcome.kind === 'verified') {
      return undefined;
    }

    return issueSession(this.sessionIssuers, outcome.userId, refreshToken);
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

    await this.emailOutbox.withAdmission('verification_email', async () => {
      await enforceAuthRateLimits(this.credentials.rateLimiter, [
        { ...REGISTRATION_RATE_LIMITS.resend.ip, key: ip },
        {
          ...AUTH_EMAIL_REQUEST_LIMIT,
          key: JSON.stringify([ip, normalizedEmail]),
        },
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
        requiresPassword: this.requireVerificationPassword,
        ...browserBindingHash(this.tokenIssuer, browserBinding),
        emailDelivery: emailDeliveryRequest(
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
    });
  }
}
