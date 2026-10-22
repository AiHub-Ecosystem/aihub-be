import { passwordHashIsCurrent } from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import { authorizeMfaSession } from '@/modules/auth/mfa/infrastructure/auth-mfa-session.guard';
import {
  type AuthRepositoryClient,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type {
  CreateWebSessionInput,
  ExchangeableWebSession,
  FindExchangeableWebSessionInput,
  RenewWebSessionInput,
  RevokeWebSessionInput,
  WebSessionRepositoryPort,
} from '@/modules/auth/web-sessions/application/web-session-repository.port';
import { insertWebSession } from './web-session-statements';

/** Stores only the token hash; see `insertWebSession` for the renewal baseline. */
export class PostgresWebSessionRepository implements WebSessionRepositoryPort {
  constructor(private readonly client: AuthRepositoryClient) {}

  async createWebSession(input: CreateWebSessionInput): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      if (
        !(await authorizeMfaSession(
          transaction,
          input.userId,
          input.mfaProof,
          input.now,
        ))
      )
        return false;

      if (
        !(await passwordHashIsCurrent(
          transaction,
          input.userId,
          input.expectedPasswordHash,
        ))
      ) {
        return false;
      }
      await insertWebSession(transaction, {
        id: input.sessionId,
        userId: input.userId,
        tokenHash: input.token.hash,
        createdAt: input.now,
        expiresAt: input.token.expiresAt,
      });
      return true;
    });
  }

  async findExchangeableWebSession(
    input: FindExchangeableWebSessionInput,
  ): Promise<ExchangeableWebSession | undefined> {
    const session = await this.client.webSession.findFirst({
      where: {
        tokenHash: input.tokenHash,
        revokedAt: null,
        expiresAt: { gt: input.now },
      },
      select: { userAccountId: true },
    });
    return session === null ? undefined : { userId: session.userAccountId };
  }

  /**
   * The forward-only sliding expiry, as one conditional statement.
   *
   * Every rule is a guard in the `WHERE` clause, so the engine decides and this
   * method never reads the row first: `revoked_at IS NULL` and
   * `expires_at > renewed_at` keep the renewal off a session that cannot be
   * exchanged, `last_renewed_at <= renewed_at_before` is the one-write-per-hour
   * throttle, and `expires_at < expiresAt` is the forward-only rule enforced
   * by the store rather than trusted from the caller. `expires_at` is a value
   * the caller derived, never the row's own value plus an increment, so two
   * concurrent exchanges can only ever settle on the later of the two.
   *
   * The updated count is how the caller learns whether a row was written; a
   * throttled or refused renewal updates none, which is a normal outcome and
   * not an error.
   */
  async renewWebSession(input: RenewWebSessionInput): Promise<boolean> {
    const renewed = await this.client.webSession.updateMany({
      where: {
        tokenHash: input.tokenHash,
        revokedAt: null,
        expiresAt: { gt: input.renewedAt, lt: input.expiresAt },
        lastRenewedAt: { lte: input.renewedAtBefore },
      },
      data: { expiresAt: input.expiresAt, lastRenewedAt: input.renewedAt },
    });
    return renewed.count > 0;
  }

  /**
   * Idempotent by construction: one conditional `UPDATE` keyed by the stored
   * hash, so an unknown, already-revoked, and live session all take the same
   * statement and the last two answer whether a row moved rather than
   * distinguishing themselves. No read, no lock, no account-wide revocation:
   * this is the presented session and nothing else.
   */
  async revokeWebSession(input: RevokeWebSessionInput): Promise<boolean> {
    const revoked = await this.client.webSession.updateMany({
      where: { tokenHash: input.tokenHash, revokedAt: null },
      data: { revokedAt: input.revokedAt },
    });
    return revoked.count > 0;
  }
}
