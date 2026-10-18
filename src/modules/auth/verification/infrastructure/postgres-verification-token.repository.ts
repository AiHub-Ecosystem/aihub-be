import type { EmailDeliveryRequestWriterPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { EmailDeliveryTransactionAdapter } from '@/modules/auth/email-delivery/infrastructure/email-delivery-transaction.adapter';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import {
  LOCK_PASSWORD_IDENTITY_SQL,
  insertEmailDelivery,
  insertRefreshSession,
} from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import { AuthIdentityConflictError } from '@/modules/auth/shared/application/auth-identity-conflict.error';
import {
  type AuthRepositoryClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
  isUniqueViolation,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type {
  ConsumeVerificationTokenInput,
  ResendVerificationTarget,
  RotateVerificationTokenInput,
  VerificationOutcome,
  VerificationTokenRepositoryPort,
} from '@/modules/auth/verification/application/verification-token-repository.port';
import type { IssuedWebSessionToken } from '@/modules/auth/web-sessions/application/web-session-token.port';
import { insertWebSession } from '@/modules/auth/web-sessions/infrastructure/web-session-statements';

const INVALID: VerificationOutcome = { kind: 'invalid' };
const VERIFIED: VerificationOutcome = { kind: 'verified' };

/**
 * One Verification Token: rotation on resend, and consumption, whose outcome
 * carries the Verification Sign-in decision and its session.
 *
 * Consumption activates the User Account and writes either a Refresh Session or
 * a Web Session inside the transaction that consumed the token, so a failed
 * session write leaves the whole request retryable while the token is
 * unexpired. Those two statements reach their tables through the shared
 * statements rather than through the adapters that own them, which is what
 * keeps one claim, one session, and one verification in one commit.
 */
export class PostgresVerificationTokenRepository
  implements VerificationTokenRepositoryPort
{
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailDeliveryRequests: EmailDeliveryRequestWriterPort = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  async rotateVerificationToken(
    input: RotateVerificationTokenInput,
  ): Promise<ResendVerificationTarget | undefined> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const rows = await authQueryRows(
          transaction,
          LOCK_PASSWORD_IDENTITY_SQL,
          [input.email],
        );
        const row = rows[0];
        if (
          row === undefined ||
          row.status !== 'pending_verification' ||
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

        await transaction.emailVerificationToken.updateMany({
          where: { userAccountId: row.id, consumedAt: null },
          data: { consumedAt: input.now, consumedReason: 'superseded' },
        });
        await transaction.emailVerificationToken.create({
          data: {
            id: input.tokenId,
            userAccountId: row.id,
            tokenHash: input.tokenHash,
            expiresAt: input.tokenExpiresAt,
            createdAt: input.now,
            browserBindingHash: input.browserBindingHash ?? null,
          },
        });
        await insertEmailDelivery(
          transaction,
          this.emailDeliveryRequests,
          input.emailDelivery,
        );
        return { email: row.canonical_email };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationOutcome> {
    return authTransaction(this.client, async (transaction) => {
      const accounts = await authQueryRows(
        transaction,
        `
          SELECT account.id, account.status
          FROM user_accounts account
          JOIN email_verification_tokens token
            ON token.user_account_id = account.id
          WHERE token.token_hash = $1
          FOR UPDATE OF account
        `,
        [input.tokenHash],
      );
      const account = accounts[0];
      if (
        account === undefined ||
        typeof account.id !== 'string' ||
        (account.status !== 'pending_verification' &&
          account.status !== 'active')
      ) {
        return INVALID;
      }
      const accountId: string = account.id;

      const tokens = await authQueryRows(
        transaction,
        `
          SELECT id, expires_at, consumed_at, consumed_reason,
                 browser_binding_hash, signed_in_at
          FROM email_verification_tokens
          WHERE user_account_id = $1 AND token_hash = $2
          FOR UPDATE
        `,
        [account.id, input.tokenHash],
      );
      const token = tokens[0];
      if (
        token === undefined ||
        typeof token.id !== 'string' ||
        !(token.expires_at instanceof Date) ||
        Number.isNaN(token.expires_at.getTime()) ||
        (token.consumed_at !== null &&
          (!(token.consumed_at instanceof Date) ||
            Number.isNaN(token.consumed_at.getTime()))) ||
        (token.consumed_reason !== null &&
          token.consumed_reason !== 'verified' &&
          token.consumed_reason !== 'superseded') ||
        (token.browser_binding_hash !== null &&
          typeof token.browser_binding_hash !== 'string') ||
        (token.signed_in_at !== null &&
          !(token.signed_in_at instanceof Date)) ||
        token.expires_at.getTime() <= input.now.getTime()
      ) {
        return INVALID;
      }

      const tokenId = token.id as string;

      const signInIfBound = async (): Promise<VerificationOutcome> => {
        // Verification Sign-in (ADR-0054): only the bound browser, only once.
        // The conditional update makes two racing requests claim it once.
        if (
          input.browserBindingHash === undefined ||
          token.browser_binding_hash !== input.browserBindingHash ||
          token.signed_in_at !== null
        ) {
          return VERIFIED;
        }
        const claimed = await transaction.emailVerificationToken.updateMany({
          where: {
            id: tokenId,
            signedInAt: null,
            consumedReason: 'verified',
          },
          data: { signedInAt: input.now },
        });
        if (claimed.count === 0) {
          return VERIFIED;
        }
        // The claim, the session it won, and the verification above commit
        // together, so a failed insert rolls all of them back and the request
        // stays retryable while the token is unexpired. The session kind is the
        // caller's to pick; the claim is the only one of its kind, so a token
        // spends its single session whichever route arrives first.
        if (input.signInSession.kind === 'refresh') {
          await insertRefreshSession(transaction, {
            userId: accountId,
            token: input.signInSession.token,
            issuedAt: input.signInSession.issuedAt,
          });
        } else {
          await this.insertWebSession(transaction, accountId, {
            sessionId: input.signInSession.sessionId,
            token: input.signInSession.token,
            issuedAt: input.signInSession.issuedAt,
          });
        }
        return { kind: 'signed_in', userId: accountId };
      };

      if (account.status === 'active') {
        return token.consumed_at instanceof Date &&
          token.consumed_reason === 'verified'
          ? signInIfBound()
          : INVALID;
      }

      if (token.consumed_at !== null || token.consumed_reason !== null) {
        return INVALID;
      }

      const consumed = await transaction.emailVerificationToken.updateMany({
        where: { id: tokenId, consumedAt: null },
        data: { consumedAt: input.now, consumedReason: 'verified' },
      });
      if (consumed.count === 0) {
        return INVALID;
      }

      const activated = await transaction.userAccount.updateMany({
        where: { id: accountId, status: 'pending_verification' },
        data: { status: 'active', updatedAt: input.now },
      });
      return activated.count > 0 ? signInIfBound() : INVALID;
    });
  }

  /**
   * The Web Session a Verification Sign-in won, written in this claim's
   * transaction. `PostgresWebSessionRepository` owns the same row for login
   * creation, which has no transaction of its own to join.
   */
  private async insertWebSession(
    transaction: AuthTransactionClient,
    userId: string,
    session: {
      readonly sessionId: string;
      readonly token: IssuedWebSessionToken;
      readonly issuedAt: Date;
    },
  ): Promise<void> {
    await insertWebSession(transaction, {
      id: session.sessionId,
      userId,
      tokenHash: session.token.hash,
      createdAt: session.issuedAt,
      expiresAt: session.token.expiresAt,
    });
  }
}
