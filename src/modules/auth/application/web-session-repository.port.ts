import type { IssuedWebSessionToken } from './web-session-token.port';

export interface CreateWebSessionInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: IssuedWebSessionToken;
  readonly now: Date;
}

export interface FindExchangeableWebSessionInput {
  readonly tokenHash: string;
  readonly now: Date;
}

export interface ExchangeableWebSession {
  readonly userId: string;
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

export interface RevokeUserWebSessionsInput {
  readonly userId: string;
  readonly revokedAt: Date;
}

/**
 * One Web Session row: the durable Customer Web login session AIHUB owns.
 *
 * `findExchangeableWebSession` answers only for a row that is neither revoked
 * nor expired, so an exchange never decides expiry for itself.
 *
 * `renewWebSession` is the forward-only sliding expiry, and it is one
 * conditional statement: the guards live in the `WHERE` clause, the caller
 * supplies the new expiry, and a row that is revoked, expired, already renewed
 * inside the throttle, or already expires later than that value is left alone
 * and reported as nothing renewed. There is no read-modify-write and no lock,
 * so concurrent BFF instances can exchange the same session freely.
 *
 * Revocation is the other half of the same conditional style, and both forms
 * are quiet: `revokeWebSession` answers whether a row moved — an unknown,
 * already-revoked, or expired token matches nothing, which is a normal answer
 * and not a failure — and `revokeWebSessionsByUser` revokes every open session
 * of one account, which is the step a password reset performs inside the
 * transaction that ends its Refresh Sessions.
 *
 * Expired and revoked rows are not purged; `0033_web_sessions.sql` carries the
 * `ponytail:` note naming the ceiling.
 */
export interface WebSessionRepositoryPort {
  createWebSession(input: CreateWebSessionInput): Promise<void>;
  findExchangeableWebSession(
    input: FindExchangeableWebSessionInput,
  ): Promise<ExchangeableWebSession | undefined>;
  /** Answers whether the row was renewed; `false` is normal, not a failure. */
  renewWebSession(input: RenewWebSessionInput): Promise<boolean>;
  /** Answers whether a session was revoked; `false` is normal, not a failure. */
  revokeWebSession(input: RevokeWebSessionInput): Promise<boolean>;
  revokeWebSessionsByUser(input: RevokeUserWebSessionsInput): Promise<number>;
}

export const WEB_SESSION_REPOSITORY = Symbol('WEB_SESSION_REPOSITORY');
