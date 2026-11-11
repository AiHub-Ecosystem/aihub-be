import type { InMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';
import type {
  CreateWebSessionInput,
  FindWebSessionForExchangeInput,
  RenewWebSessionInput,
  RevokeWebSessionInput,
  RevokeWebSessionResult,
  WebSessionForExchange,
  WebSessionRepositoryPort,
} from '@/modules/auth/web-sessions/application/web-session-repository.port';

/**
 * The in-memory Web Session store, and the durable guarantees it has to hold
 * honestly or the unit lane would only be asserting them:
 *
 * - session reads return expiry and revocation data; application policy decides
 *   whether a session can be exchanged;
 * - renewal writes only when the last renewal is older than the throttle the
 *   caller supplies, and only forward — an `expiresAt` at or before the stored
 *   one is refused rather than applied, which is what makes a caller-derived
 *   value safe;
 * - renewal is a single reassignment of the row's own fields, so concurrent
 *   exchanges of one session cannot interleave into a lost or doubled write;
 * - revocation is idempotent and quiet: an unknown or already-revoked session
 *   reports nothing revoked rather than throwing; logout preserves its bodyless
 *   `204` contract for both outcomes.
 */
export class InMemoryWebSessionAdapter implements WebSessionRepositoryPort {
  /** Fails the next durable write, as a database outage would. */
  failCreateWebSession = false;
  /** Fails the next durable read, as an unreachable database would. */
  failFindWebSession = false;
  failRenewWebSession = false;
  failRevokeWebSession = false;

  constructor(private readonly state: InMemoryAuthState) {}

  async createWebSession(input: CreateWebSessionInput): Promise<boolean> {
    if (this.failCreateWebSession) {
      throw new Error('durable store unavailable');
    }
    const account = this.state.accounts.get(input.userId);
    if (
      account?.status !== 'active' ||
      account.passwordHash !== input.expectedPasswordHash
    ) {
      return false;
    }
    const factor = this.state.mfaFactors.get(input.userId);
    if (factor?.status === 'enabled') {
      if (
        input.mfaProof?.kind === 'totp' &&
        input.mfaProof.factorId === factor.factorId
      ) {
        // The application verified this factor snapshot before the transaction.
      } else if (
        input.mfaProof?.kind === 'recovery' &&
        this.state.recoveryCodes
          .get(input.userId)
          ?.delete(input.mfaProof.codeHash)
      ) {
        // Recovery proof consumption and session creation share this write.
      } else {
        return false;
      }
    } else if (input.mfaProof !== undefined) {
      return false;
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
    return true;
  }

  async findWebSessionForExchange(
    input: FindWebSessionForExchangeInput,
  ): Promise<WebSessionForExchange | undefined> {
    if (this.failFindWebSession) {
      throw new Error('durable store unavailable');
    }
    const row = this.state.webSessions.get(input.tokenHash);
    return row === undefined
      ? undefined
      : {
          sessionId: row.sessionId,
          userId: row.userId,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt ?? null,
        };
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

  async revokeWebSession(
    input: RevokeWebSessionInput,
  ): Promise<RevokeWebSessionResult> {
    if (this.failRevokeWebSession) {
      throw new Error('durable store unavailable');
    }
    const row = this.state.webSessions.get(input.tokenHash);
    if (row === undefined || row.revokedAt !== undefined) {
      return { kind: 'not_revoked', sessionsRevoked: 0 };
    }
    row.revokedAt = input.revokedAt;
    return { kind: 'revoked', userId: row.userId, sessionsRevoked: 1 };
  }
}
