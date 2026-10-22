import type {
  EmailDeliveryRequestWriterPort,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailDeliveryTransactionAdapter } from '@/modules/auth/email-delivery/infrastructure/email-delivery-transaction.adapter';
import {
  type SessionAdmission,
  assertAdmitted,
} from '@/modules/auth/mfa/infrastructure/auth-mfa-session.guard';
import {
  type AuthSqlClient,
  type AuthTransactionClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { RefreshSessionRowInput } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';

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
 * The account row, locked before any token row of that account. Every
 * transaction that touches an account's credentials or sessions takes the
 * account first, so a reset and a Refresh Token rotation queue behind each
 * other instead of each holding what the other waits for (ADR-0025).
 */
export const LOCK_ACCOUNT_SQL =
  'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE';

/**
 * Locks the account a token belongs to, found by `ownerSql` (which selects its
 * `user_account_id` without locking). A token's account never changes, so the
 * unlocked read is safe; the caller reads the token again under the lock.
 * Answers `false` when no token matches, without taking any lock.
 */
export async function lockOwningAccount(
  transaction: AuthSqlClient,
  ownerSql: string,
  values: readonly unknown[],
): Promise<boolean> {
  const owner = await authQueryRows(transaction, ownerSql, values);
  const accountId = owner[0]?.['user_account_id'];
  if (typeof accountId !== 'string') {
    return false;
  }
  await authQueryRows(transaction, LOCK_ACCOUNT_SQL, [accountId]);
  return true;
}

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
      new EmailDeliveryTransactionAdapter(transaction),
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
  input: RefreshSessionRowInput,
  admission: SessionAdmission,
): Promise<void> {
  assertAdmitted(admission, input.userId);
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

/**
 * Whether the account still holds the password hash a sign-in verified. It is a
 * fresh statement taken after the caller's account lock, so a reset that
 * committed in between is seen rather than hidden behind an earlier snapshot.
 */
export async function passwordHashIsCurrent(
  client: AuthSqlClient,
  userId: string,
  expectedPasswordHash: string,
): Promise<boolean> {
  const identity = await client.authIdentity.findFirst({
    where: { userAccountId: userId, provider: 'password' },
    select: { passwordHash: true },
  });
  return identity?.passwordHash === expectedPasswordHash;
}
