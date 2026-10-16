import type {
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import type { CreateRefreshSessionInput } from '@/modules/auth/application/refresh-session-repository.port';
import type { AuthSqlClient, AuthTransactionClient } from './auth-prisma';

/**
 * The two statements that cross an aggregate boundary inside one transaction.
 * The adapter owning the primary aggregate calls them with the transaction it
 * already holds, so the operation stays one durable step instead of becoming
 * several a later statement could leave half-applied.
 *
 * Shared the way `web-session-statements.ts` is: the insert each caller needs
 * must be the identical statement, or the two copies drift the first time the
 * table changes.
 */

/**
 * The Email Delivery Request rides the caller's open transaction, so a failure
 * here rolls back the mutation it serves (ADR-0074).
 */
export async function insertEmailDelivery(
  transaction: AuthTransactionClient,
  emailDeliveryRequests: EmailDeliveryRequestWriterPort,
  emailDelivery: InsertEmailDeliveryRequestInput | undefined,
): Promise<void> {
  if (emailDelivery !== undefined) {
    await emailDeliveryRequests.insert(
      transaction as unknown as EmailDeliveryTransaction,
      emailDelivery,
    );
  }
}

/**
 * Stores only the token hash, on the client or inside a transaction. The
 * Verification Sign-in reaches it from the verification adapter, so the claim
 * and the session it won commit together.
 */
export async function insertRefreshSession(
  client: AuthSqlClient,
  input: CreateRefreshSessionInput,
): Promise<void> {
  await client.refreshToken.create({
    data: {
      id: input.token.id,
      familyId: input.token.familyId,
      userAccountId: input.userId,
      tokenHash: input.token.hash,
      issuedAt: input.issuedAt,
      expiresAt: input.token.expiresAt,
    },
  });
}
