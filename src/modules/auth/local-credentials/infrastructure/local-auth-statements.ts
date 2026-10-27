import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
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
 * The prologue a token issue shares: lock the password identity with its
 * account, refuse an account outside the one status the flow serves, and
 * reserve the recipient's daily email budget when a message will be queued.
 * `undefined` answers a missing, wrongly-statused or over-budget recipient the
 * same way, so a caller learns nothing about which it was.
 */
export async function lockIssuableIdentity(
  transaction: AuthTransactionClient,
  emailDeliveryRequests: EmailDeliveryRequestWriterPort,
  input: {
    readonly email: string;
    readonly now: Date;
    readonly emailDelivery?: InsertEmailDeliveryRequestInput | undefined;
  },
  acceptedStatus: LocalAccountStatus,
): Promise<{ readonly id: string; readonly email: string } | undefined> {
  const rows = await authQueryRows(transaction, LOCK_PASSWORD_IDENTITY_SQL, [
    input.email,
  ]);
  const row = rows[0];
  if (
    row === undefined ||
    row.status !== acceptedStatus ||
    typeof row.id !== 'string' ||
    typeof row.canonical_email !== 'string'
  ) {
    return undefined;
  }

  if (
    input.emailDelivery !== undefined &&
    !(await emailDeliveryRequests.reserveAuthenticationEmailRecipient(
      new EmailDeliveryTransactionAdapter(transaction),
      { email: input.email, now: input.now },
    ))
  ) {
    return undefined;
  }
  return { id: row.id, email: row.canonical_email };
}

/**
 * The prologue an MFA factor change shares: the active account, then its
 * password identity, both locked in that order. `undefined` when the account is
 * not active or has no password identity.
 */
export async function lockActivePasswordIdentity(
  transaction: AuthSqlClient,
  userId: string,
): Promise<
  | { readonly canonicalEmail: unknown; readonly passwordHash: unknown }
  | undefined
> {
  const accounts = await authQueryRows(transaction, LOCK_ACCOUNT_SQL, [userId]);
  if (accounts[0]?.['status'] !== 'active') return undefined;
  const identities = await authQueryRows(
    transaction,
    `SELECT canonical_email, password_hash FROM auth_identities
     WHERE user_account_id = $1 AND provider = 'password' FOR UPDATE`,
    [userId],
  );
  const identity = identities[0];
  return identity === undefined
    ? undefined
    : {
        canonicalEmail: identity['canonical_email'],
        passwordHash: identity['password_hash'],
      };
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
