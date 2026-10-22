import type { EmailDeliveryRequestWriterPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailDeliveryTransactionAdapter } from '@/modules/auth/email-delivery/infrastructure/email-delivery-transaction.adapter';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import {
  LOCK_PASSWORD_IDENTITY_SQL,
  insertEmailDelivery,
  lockOwningAccount,
} from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import type {
  IssuePasswordResetTokenInput,
  PasswordResetResult,
  PasswordResetTarget,
  PasswordResetTokenCheckResult,
  PasswordResetTokenRepositoryPort,
} from '@/modules/auth/password-reset/application/password-reset-token-repository.port';
import {
  type AuthRepositoryClient,
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { isAccountStatus } from '@/modules/auth/shared/infrastructure/auth-row';
import { revokeUserWebSessions } from '@/modules/auth/web-sessions/infrastructure/web-session-statements';

/** The password-reset token and its account, as the two reads project them. */
interface PasswordResetTokenRow {
  readonly id: string;
  readonly userAccountId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly status: string;
}

type PasswordResetTokenInspection =
  | { readonly kind: 'valid'; readonly id: string; readonly userId: string }
  | {
      readonly kind: 'invalid';
      readonly reason: 'missing' | 'inactive' | 'expired' | 'consumed';
    };

function inspectPasswordResetToken(
  row: PasswordResetTokenRow | undefined,
  now: Date,
): PasswordResetTokenInspection {
  if (row === undefined) {
    return { kind: 'invalid', reason: 'missing' };
  }
  if (
    Number.isNaN(row.expiresAt.getTime()) ||
    (row.consumedAt !== null && Number.isNaN(row.consumedAt.getTime())) ||
    !isAccountStatus(row.status)
  ) {
    return { kind: 'invalid', reason: 'missing' };
  }
  if (row.status !== 'active') {
    return { kind: 'invalid', reason: 'inactive' };
  }
  if (row.consumedAt !== null) {
    return { kind: 'invalid', reason: 'consumed' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'invalid', reason: 'expired' };
  }
  return { kind: 'valid', id: row.id, userId: row.userAccountId };
}

/** The account a reset token belongs to; the token's account never changes. */
const PASSWORD_RESET_ACCOUNT_SQL =
  'SELECT user_account_id FROM password_reset_tokens WHERE token_hash = $1';

/**
 * The reset token joined to its account, aliased to the model's field names so
 * the locking read (SQL) and the plain read (generated client) map the same way.
 * Only the token row is locked here: the account is already held by the caller.
 */
const LOCK_PASSWORD_RESET_SQL = `
  SELECT token.id,
         token.user_account_id AS "userAccountId",
         token.expires_at AS "expiresAt",
         token.consumed_at AS "consumedAt",
         account.status
  FROM password_reset_tokens token
  JOIN user_accounts account ON account.id = token.user_account_id
  WHERE token.token_hash = $1
  FOR UPDATE OF token
`;

/**
 * One Password Reset Token: issue, check, and the reset that consumes it.
 *
 * The reset changes the password, consumes every open reset token, and revokes
 * every Refresh Session and Web Session of the account as one transaction
 * (ADR-0025). The other three tables are written from here rather than through
 * their adapters, because a second transaction between them would let an
 * exchange racing it observe a half-revoked account.
 */
export class PostgresPasswordResetTokenRepository
  implements PasswordResetTokenRepositoryPort
{
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailDeliveryRequests: EmailDeliveryRequestWriterPort = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  async issuePasswordResetToken(
    input: IssuePasswordResetTokenInput,
  ): Promise<PasswordResetTarget | undefined> {
    return authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows(
        transaction,
        LOCK_PASSWORD_IDENTITY_SQL,
        [input.email],
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.status !== 'active' ||
        typeof row.id !== 'string' ||
        typeof row.canonical_email !== 'string'
      ) {
        return undefined;
      }

      if (
        input.emailDelivery !== undefined &&
        !(await this.emailDeliveryRequests.reserveAuthenticationEmailRecipient(
          new EmailDeliveryTransactionAdapter(transaction),
          { email: input.email, now: input.now },
        ))
      ) {
        return undefined;
      }

      await transaction.passwordResetToken.updateMany({
        where: { userAccountId: row.id, consumedAt: null },
        data: { consumedAt: input.now },
      });
      await transaction.passwordResetToken.create({
        data: {
          id: input.tokenId,
          userAccountId: row.id,
          tokenHash: input.tokenHash,
          expiresAt: input.tokenExpiresAt,
          createdAt: input.now,
        },
      });
      await insertEmailDelivery(
        transaction,
        this.emailDeliveryRequests,
        input.emailDelivery,
      );
      return { email: row.canonical_email };
    });
  }

  async checkPasswordResetToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<PasswordResetTokenCheckResult> {
    const token = await this.client.passwordResetToken.findUnique({
      where: { tokenHash: input.tokenHash },
      select: {
        id: true,
        userAccountId: true,
        expiresAt: true,
        consumedAt: true,
        userAccount: { select: { status: true } },
      },
    });
    const inspection = inspectPasswordResetToken(
      token === null
        ? undefined
        : {
            id: token.id,
            userAccountId: token.userAccountId,
            expiresAt: token.expiresAt,
            consumedAt: token.consumedAt,
            status: token.userAccount.status,
          },
      input.now,
    );
    return inspection.kind === 'valid' ? { kind: 'valid' } : inspection;
  }

  async consumePasswordReset(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<PasswordResetResult> {
    return authTransaction(this.client, async (transaction) => {
      // Lock order: the User Account, then its tokens (ADR-0025). The token is
      // read again under the lock, so a reset or a reset-link request that won
      // the account first is seen as a consumed token, not raced.
      if (
        !(await lockOwningAccount(transaction, PASSWORD_RESET_ACCOUNT_SQL, [
          input.tokenHash,
        ]))
      ) {
        return { kind: 'invalid', reason: 'missing' };
      }
      const rows = await authQueryRows<PasswordResetTokenRow>(
        transaction,
        LOCK_PASSWORD_RESET_SQL,
        [input.tokenHash],
      );
      const inspection = inspectPasswordResetToken(rows[0], input.now);
      if (inspection.kind === 'invalid') {
        return inspection;
      }

      // The token is spent before the password changes, so a token that was
      // spent after it was read answers as consumed with nothing written.
      const consumed = await transaction.passwordResetToken.updateMany({
        where: { id: inspection.id, consumedAt: null },
        data: { consumedAt: input.now },
      });
      if (consumed.count === 0) {
        return { kind: 'invalid', reason: 'consumed' };
      }

      const identity = await transaction.authIdentity.updateMany({
        where: { userAccountId: inspection.userId, provider: 'password' },
        data: { passwordHash: input.passwordHash, updatedAt: input.now },
      });
      if (identity.count === 0) {
        throw new Error('local password identity is missing');
      }
      await transaction.passwordResetToken.updateMany({
        where: { userAccountId: inspection.userId, consumedAt: null },
        data: { consumedAt: input.now },
      });
      await transaction.refreshToken.updateMany({
        where: { userAccountId: inspection.userId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      // The same durable step, one more statement: whoever knew the old
      // password loses every Customer Web session as well, and because both
      // revocations ride this transaction a failure anywhere rolls both back, so
      // an exchange racing it can never observe a half-revoked account.
      await revokeUserWebSessions(transaction, inspection.userId, input.now);
      return { kind: 'reset' };
    });
  }
}
