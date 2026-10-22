import {
  type SessionAdmission,
  assertAdmitted,
} from '@/modules/auth/mfa/infrastructure/auth-mfa-session.guard';
import type { Prisma } from '@prisma-client/client';

type WebSessions = Pick<Prisma.TransactionClient, 'webSession'>;

/**
 * Stores only the token hash. `lastRenewedAt` starts equal to `createdAt`:
 * creation is the first renewal, so the exchange throttle has a baseline to
 * measure from without a separate column.
 *
 * Shared because the password reset that ends an account's sessions and the
 * session store both create one inside a transaction they own, and must run
 * the identical statement so the two cannot drift.
 */
export async function insertWebSession(
  client: WebSessions,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
  admission: SessionAdmission,
): Promise<void> {
  assertAdmitted(admission, input.userId);
  await client.webSession.create({
    data: {
      id: input.id,
      userAccountId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      lastRenewedAt: input.createdAt,
    },
  });
}

/**
 * Revokes every open Web Session of one account, with the same guard the
 * per-session revocation uses, so a row that is already revoked keeps its first
 * revocation instant.
 *
 * Shared because the password reset and the MFA changes end an account's Web
 * Sessions in the transaction they already hold; they cannot call through the
 * session store, which owns its own.
 */
export async function revokeUserWebSessions(
  client: WebSessions,
  userId: string,
  revokedAt: Date,
): Promise<void> {
  await client.webSession.updateMany({
    where: { userAccountId: userId, revokedAt: null },
    data: { revokedAt },
  });
}
