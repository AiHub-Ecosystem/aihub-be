import type {
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type {
  AuthSqlClient,
  AuthTransactionClient,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { CreateRefreshSessionInput } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';

/**
 * What two aggregates share inside one transaction. The adapter owning the
 * primary aggregate calls these with the transaction it already holds, so the
 * operation stays one durable step instead of becoming several a later
 * statement could leave half-applied.
 *
 * Shared the way `web-session-statements.ts` is: the statement each caller
 * needs must be the identical one, or the two copies drift the first time the
 * table changes.
 */

/**
 * The password identity a resend or a reset issues a token for, locked together
 * with its account so neither the account nor the identity can move between the
 * read and the token write. The caller supplies the status it accepts.
 */
export const LOCK_PASSWORD_IDENTITY_SQL = `
  SELECT ua.id, ai.canonical_email, ua.status
  FROM user_accounts ua
  JOIN auth_identities ai ON ai.user_account_id = ua.id
  WHERE ai.provider = 'password' AND ai.canonical_email = $1
  FOR UPDATE
`;

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
