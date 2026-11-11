import type { MfaSessionProof } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import type { IssuedWebSessionToken } from './web-session-token.port';

export interface CreateWebSessionInput {
  readonly sessionId: string;
  readonly userId: string;
  /** The hash Argon2 verified; rechecked while serialized with password reset. */
  readonly expectedPasswordHash: string;
  readonly token: IssuedWebSessionToken;
  readonly now: Date;
  readonly mfaProof?: MfaSessionProof;
}

export interface FindWebSessionForExchangeInput {
  readonly tokenHash: string;
}

export interface WebSessionForExchange {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface RenewWebSessionInput {
  readonly tokenHash: string;
  /**
   * The new expiry, derived from the caller: 30 days from now. Never the row's
   * current expiry plus an increment, so no read is needed and two exchanges
   * cannot push it backwards.
   */
  readonly expiresAt: Date;
  readonly renewedAt: Date;
  /**
   * The throttle: renew only when the stored `last_renewed_at` is at or before
   * this instant, so a burst of exchanges writes one row update, not one per
   * request.
   */
  readonly renewedAtBefore: Date;
}

export interface RevokeWebSessionInput {
  readonly tokenHash: string;
  readonly revokedAt: Date;
}

export type RevokeWebSessionResult =
  | {
      readonly kind: 'revoked';
      readonly userId: string;
      readonly sessionsRevoked: 1;
    }
  | { readonly kind: 'not_revoked'; readonly sessionsRevoked: 0 };

/**
 * One Web Session row: the durable Customer Web login session AIHUB owns.
 *
 * `findWebSessionForExchange` returns the persisted expiry and revocation
 * fields. Application policy decides whether the session may be exchanged.
 *
 * `renewWebSession` is the forward-only sliding expiry, and it is one
 * conditional statement: the guards live in the `WHERE` clause, the caller
 * supplies the new expiry, and a row that is revoked, expired, already renewed
 * inside the throttle, or already expires later than that value is left alone
 * and reported as nothing renewed. There is no read-modify-write and no lock,
 * so concurrent BFF instances can exchange the same session freely.
 *
 * Per-session revocation is idempotent and returns the account/count only when
 * the conditional update changed a row. Account-wide revocation belongs to the
 * password-reset transaction, not to this port.
 *
 * Expired and revoked rows are not purged; `0033_web_sessions.sql` carries the
 * `ponytail:` note naming the ceiling.
 */
export interface WebSessionRepositoryPort {
  /** Atomically creates a session for a still-active, unchanged password identity.
   * Returns false when credentials changed; throws when persistence failed.
   */
  createWebSession(input: CreateWebSessionInput): Promise<boolean>;
  findWebSessionForExchange(
    input: FindWebSessionForExchangeInput,
  ): Promise<WebSessionForExchange | undefined>;
  /** Answers whether the row was renewed; `false` is normal, not a failure. */
  renewWebSession(input: RenewWebSessionInput): Promise<boolean>;
  /** Returns the account and count only when a session row was revoked. */
  revokeWebSession(
    input: RevokeWebSessionInput,
  ): Promise<RevokeWebSessionResult>;
}

export const WEB_SESSION_REPOSITORY = Symbol('WEB_SESSION_REPOSITORY');
