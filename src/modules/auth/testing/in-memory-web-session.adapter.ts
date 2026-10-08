import type {
  CreateWebSessionInput,
  ExchangeableWebSession,
  FindExchangeableWebSessionInput,
  RenewWebSessionInput,
  WebSessionRepositoryPort,
} from '@/modules/auth/application/web-session-repository.port';
import type { InMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';

/**
 * The in-memory Web Session store, and the durable guarantees it has to hold
 * honestly or the unit lane would only be asserting them:
 *
 * - only a row that is neither revoked nor expired can be exchanged;
 * - renewal writes only when the last renewal is older than the throttle the
 *   caller supplies, and only forward — an `expiresAt` at or before the stored
 *   one is refused rather than applied, which is what makes a caller-derived
 *   value safe;
 * - renewal is a single reassignment of the row's own fields, so concurrent
 *   exchanges of one session cannot interleave into a lost or doubled write.
 */
export class InMemoryWebSessionAdapter implements WebSessionRepositoryPort {
  /** Fails the next durable write, as a database outage would. */
  failCreateWebSession = false;
  /** Fails the next durable read, as an unreachable database would. */
  failFindWebSession = false;
  failRenewWebSession = false;

  constructor(private readonly state: InMemoryAuthState) {}

  async createWebSession(input: CreateWebSessionInput): Promise<void> {
    if (this.failCreateWebSession) {
      throw new Error('durable store unavailable');
    }
    this.state.webSessions.set(input.token.hash, {
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.token.hash,
      createdAt: input.now,
      expiresAt: input.token.expiresAt,
      lastRenewedAt: input.now,
      revokedAt: undefined,
    });
  }

  async findExchangeableWebSession(
    input: FindExchangeableWebSessionInput,
  ): Promise<ExchangeableWebSession | undefined> {
    if (this.failFindWebSession) {
      throw new Error('durable store unavailable');
    }
    const row = this.state.webSessions.get(input.tokenHash);
    if (
      row === undefined ||
      row.revokedAt !== undefined ||
      row.expiresAt.getTime() <= input.now.getTime()
    ) {
      return undefined;
    }
    return { userId: row.userId };
  }

  async renewWebSession(input: RenewWebSessionInput): Promise<boolean> {
    if (this.failRenewWebSession) {
      throw new Error('durable store unavailable');
    }
    const row = this.state.webSessions.get(input.tokenHash);
    if (
      row === undefined ||
      row.revokedAt !== undefined ||
      row.expiresAt.getTime() <= input.renewedAt.getTime() ||
      row.lastRenewedAt.getTime() > input.renewedAtBefore.getTime() ||
      row.expiresAt.getTime() >= input.expiresAt.getTime()
    ) {
      return false;
    }
    row.expiresAt = input.expiresAt;
    row.lastRenewedAt = input.renewedAt;
    return true;
  }
}
