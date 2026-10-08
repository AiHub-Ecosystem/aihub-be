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
}

export const WEB_SESSION_REPOSITORY = Symbol('WEB_SESSION_REPOSITORY');
