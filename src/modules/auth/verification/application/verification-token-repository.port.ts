import type { InsertEmailDeliveryRequestInput } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import type { IssuedWebSessionToken } from '@/modules/auth/web-sessions/application/web-session-token.port';

export interface ResendVerificationTarget {
  readonly email: string;
}

/**
 * `verified`: the email is (or already was) verified; no session.
 * `signed_in`: the Signup Browser Binding matched and this token's one
 * Verification Sign-in was claimed for `userId`.
 */
export type VerificationOutcome =
  | { readonly kind: 'invalid' }
  /**
   * The token needs the registration password and the caller did not prove it
   * (ADR-0123). Nothing was consumed.
   */
  | { readonly kind: 'password_required' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'signed_in'; readonly userId: string };

export interface RotateVerificationTokenInput {
  readonly email: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenExpiresAt: Date;
  readonly browserBindingHash?: string;
  /** Whether verifying this token needs the registration password (ADR-0123). */
  readonly requiresPassword: boolean;
  readonly now: Date;
  /** Written in the same transaction as the rotation, or nowhere. */
  readonly emailDelivery?: InsertEmailDeliveryRequestInput;
}

/** What a caller needs to prove a token's password before consuming it. */
export interface VerificationCredential {
  readonly requiresPassword: boolean;
  /** The pending account's stored password hash. */
  readonly passwordHash: string;
}

export interface ConsumeVerificationTokenInput {
  readonly tokenHash: string;
  readonly browserBindingHash?: string;
  /**
   * The stored password hash the caller verified a submitted password against
   * (ADR-0123). A token that requires the password is consumed only when this
   * equals the hash stored now, under the account lock, so a registration that
   * replaced the credential after the check is seen.
   */
  readonly verifiedPasswordHash?: string;
  /**
   * The pre-issued session a Verification Sign-in commits together with its
   * claim and the verification that precedes it (ADR-0054). It is stored only
   * when the sign-in is actually granted, so a request that merely verifies
   * leaves no session behind.
   *
   * The kind is part of the input rather than a second claim method, because
   * "one verification token creates at most one session in total" is only
   * enforceable when both kinds pass through the same conditional claim. A
   * caller picks the kind; it never picks the row.
   */
  readonly signInSession:
    | {
        readonly kind: 'refresh';
        readonly token: IssuedRefreshToken;
        readonly issuedAt: Date;
      }
    | {
        readonly kind: 'web-session';
        readonly sessionId: string;
        readonly token: IssuedWebSessionToken;
        readonly issuedAt: Date;
      };
  readonly now: Date;
}

/**
 * One Verification Token: rotation on resend, and consumption, whose outcome
 * carries the Verification Sign-in decision and its Refresh Session.
 *
 * The claim, its Refresh Session, and the verification itself commit as one
 * durable step, so a failed session write leaves the whole request retryable
 * while the token is unexpired.
 *
 * `rotateVerificationToken` throws `AuthIdentityConflictError` when the issued
 * token hash is already stored.
 */
export interface VerificationTokenRepositoryPort {
  rotateVerificationToken(
    input: RotateVerificationTokenInput,
  ): Promise<ResendVerificationTarget | undefined>;
  consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationOutcome>;
  /**
   * The open, unexpired token's password requirement and the pending account's
   * stored hash, or nothing for a token that is unknown, spent, expired, or
   * whose account is no longer pending.
   */
  readVerificationCredential(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<VerificationCredential | undefined>;
  /**
   * Counts one wrong password against an open token in a single statement, and
   * spends the token when the count reaches `limit`.
   */
  recordWrongVerificationPassword(input: {
    readonly tokenHash: string;
    readonly now: Date;
    readonly limit: number;
  }): Promise<void>;
}

export const VERIFICATION_TOKEN_REPOSITORY = Symbol(
  'VERIFICATION_TOKEN_REPOSITORY',
);
