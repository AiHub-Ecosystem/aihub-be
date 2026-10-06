import type { InsertEmailDeliveryRequestInput } from './email-delivery-request.port';
import type { IssuedRefreshToken } from './refresh-token.port';

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
  | { readonly kind: 'verified' }
  | { readonly kind: 'signed_in'; readonly userId: string };

export interface RotateVerificationTokenInput {
  readonly email: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenExpiresAt: Date;
  readonly browserBindingHash?: string;
  readonly now: Date;
  /** Written in the same transaction as the rotation, or nowhere. */
  readonly emailDelivery?: InsertEmailDeliveryRequestInput;
}

export interface ConsumeVerificationTokenInput {
  readonly tokenHash: string;
  readonly browserBindingHash?: string;
  /**
   * The pre-issued Refresh Session a Verification Sign-in commits together
   * with its claim and the verification that precedes it (ADR-0054). It is
   * stored only when the sign-in is actually granted, so a request that merely
   * verifies leaves no session behind.
   */
  readonly signInSession: {
    readonly token: IssuedRefreshToken;
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
}

export const VERIFICATION_TOKEN_REPOSITORY = Symbol(
  'VERIFICATION_TOKEN_REPOSITORY',
);
