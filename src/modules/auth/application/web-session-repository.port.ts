import type { IssuedWebSessionToken } from './web-session-token.port';

export interface CreateWebSessionInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: IssuedWebSessionToken;
  readonly now: Date;
}

/**
 * One Web Session row: the durable Customer Web login session AIHUB owns.
 *
 * Creation is all this slice needs; exchange, renewal, and revocation add their
 * own methods beside it. No Refresh Token table is reused for a Web Session.
 *
 * Expired and revoked rows are not purged; `0033_web_sessions.sql` carries the
 * `ponytail:` note naming the ceiling.
 */
export interface WebSessionRepositoryPort {
  createWebSession(input: CreateWebSessionInput): Promise<void>;
}

export const WEB_SESSION_REPOSITORY = Symbol('WEB_SESSION_REPOSITORY');
