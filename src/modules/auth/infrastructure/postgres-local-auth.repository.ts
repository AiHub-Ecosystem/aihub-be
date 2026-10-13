import { ulid } from 'ulid';

import { AuthIdentityConflictError } from '@/modules/auth/application/auth-identity-conflict.error';
import type {
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import type {
  IssuePasswordResetTokenInput,
  PasswordResetResult,
  PasswordResetTarget,
  PasswordResetTokenCheckResult,
  PasswordResetTokenRepositoryPort,
} from '@/modules/auth/application/password-reset-token-repository.port';
import type {
  CreateRefreshSessionInput,
  RefreshSessionRepositoryPort,
  RefreshTokenRecord,
  RefreshTokenRotationResult,
  RotateRefreshTokenInput,
} from '@/modules/auth/application/refresh-session-repository.port';
import type {
  LoginIdentity,
  RegisterLocalAccountInput,
  UserAccountRepositoryPort,
} from '@/modules/auth/application/user-account.port';
import type {
  ConsumeVerificationTokenInput,
  ResendVerificationTarget,
  RotateVerificationTokenInput,
  VerificationOutcome,
  VerificationTokenRepositoryPort,
} from '@/modules/auth/application/verification-token-repository.port';
import type { IssuedWebSessionToken } from '@/modules/auth/application/web-session-token.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import { authorizeMfaSession } from './auth-mfa-session.guard';
import {
  type AuthRepositoryClient,
  type AuthSqlClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
} from './auth-prisma';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';
import {
  insertWebSession,
  revokeUserWebSessions,
} from './web-session-statements';

const INVALID: VerificationOutcome = { kind: 'invalid' };
const VERIFIED: VerificationOutcome = { kind: 'verified' };

/**
 * A duplicate key from either path: the SQLSTATE a raw statement reports, or
 * the code Prisma gives a model operation for the same violation.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return code === '23505' || code === 'P2002';
}

function isAccountStatus(
  status: unknown,
): status is 'pending_verification' | 'active' | 'disabled' {
  return (
    status === 'pending_verification' ||
    status === 'active' ||
    status === 'disabled'
  );
}

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

/**
 * The reset token joined to its account, aliased to the model's field names so
 * the locking read (SQL) and the plain read (generated client) map the same way.
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
  FOR UPDATE
`;

/** The refresh token and its account's status, locked for rotation. */
const LOCK_REFRESH_TOKEN_SQL = `
  SELECT token.id,
         token.family_id AS "familyId",
         token.user_account_id AS "userAccountId",
         token.expires_at AS "expiresAt",
         token.used_at AS "usedAt",
         token.revoked_at AS "revokedAt",
         account.status
  FROM refresh_tokens token
  JOIN user_accounts account ON account.id = token.user_account_id
  WHERE token.id = $1 AND token.token_hash = $2
  FOR UPDATE
`;

interface RefreshTokenRow {
  readonly id: string;
  readonly familyId: string;
  readonly userAccountId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}

export class PostgresLocalAuthRepository
  implements
    UserAccountRepositoryPort,
    VerificationTokenRepositoryPort,
    PasswordResetTokenRepositoryPort,
    RefreshSessionRepositoryPort
{
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailDeliveryRequests: EmailDeliveryRequestWriterPort = new PostgresEmailDeliveryRequestRepository(),
  ) {}

  async register(
    input: RegisterLocalAccountInput,
  ): Promise<'queued' | 'suppressed'> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const recipientAllowed =
          input.emailDelivery === undefined ||
          (await this.emailDeliveryRequests.reserveAuthenticationEmailRecipient(
            transaction as unknown as EmailDeliveryTransaction,
            { email: input.email, now: input.now },
          ));
        const userId = `usr_${ulid()}`;
        await transaction.userAccount.create({
          data: {
            id: userId,
            username: input.username,
            status: 'pending_verification',
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        await transaction.authIdentity.create({
          data: {
            id: `auth_${ulid()}`,
            userAccountId: userId,
            provider: 'password',
            canonicalEmail: input.email,
            passwordHash: input.passwordHash,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        await transaction.emailVerificationToken.create({
          data: {
            id: input.tokenId,
            userAccountId: userId,
            tokenHash: input.tokenHash,
            expiresAt: input.tokenExpiresAt,
            createdAt: input.now,
            browserBindingHash: input.browserBindingHash ?? null,
          },
        });
        if (recipientAllowed) {
          await this.insertEmailDelivery(transaction, input.emailDelivery);
        }
        return recipientAllowed ? 'queued' : 'suppressed';
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async rotateVerificationToken(
    input: RotateVerificationTokenInput,
  ): Promise<ResendVerificationTarget | undefined> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const rows = await authQueryRows(
          transaction,
          `
            SELECT ua.id, ai.canonical_email, ua.status
            FROM user_accounts ua
            JOIN auth_identities ai ON ai.user_account_id = ua.id
            WHERE ai.provider = 'password' AND ai.canonical_email = $1
            FOR UPDATE
          `,
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
            transaction as unknown as EmailDeliveryTransaction,
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
        await this.insertEmailDelivery(transaction, input.emailDelivery);
        return { email: row.canonical_email };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async issuePasswordResetToken(
    input: IssuePasswordResetTokenInput,
  ): Promise<PasswordResetTarget | undefined> {
    return authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows(
        transaction,
        `
          SELECT ua.id, ai.canonical_email, ua.status
          FROM user_accounts ua
          JOIN auth_identities ai ON ai.user_account_id = ua.id
          WHERE ai.provider = 'password' AND ai.canonical_email = $1
          FOR UPDATE
        `,
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
          transaction as unknown as EmailDeliveryTransaction,
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
      await this.insertEmailDelivery(transaction, input.emailDelivery);
      return { email: row.canonical_email };
    });
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
          await this.insertRefreshSession(transaction, {
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
      const rows = await authQueryRows<PasswordResetTokenRow>(
        transaction,
        LOCK_PASSWORD_RESET_SQL,
        [input.tokenHash],
      );
      const inspection = inspectPasswordResetToken(rows[0], input.now);
      if (inspection.kind === 'invalid') {
        return inspection;
      }

      const identity = await transaction.authIdentity.updateMany({
        where: { userAccountId: inspection.userId, provider: 'password' },
        data: { passwordHash: input.passwordHash, updatedAt: input.now },
      });
      if (identity.count === 0) {
        throw new Error('local password identity is missing');
      }

      const consumed = await transaction.passwordResetToken.updateMany({
        where: { id: inspection.id, consumedAt: null },
        data: { consumedAt: input.now },
      });
      if (consumed.count === 0) {
        throw new Error('password reset token was concurrently consumed');
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

  async findLoginIdentityByEmail(
    email: string,
  ): Promise<LoginIdentity | undefined> {
    const identity = await this.client.authIdentity.findFirst({
      where: { provider: 'password', canonicalEmail: email },
      select: {
        canonicalEmail: true,
        passwordHash: true,
        userAccount: { select: { id: true, status: true } },
      },
    });
    if (identity === null) {
      return undefined;
    }
    if (!isAccountStatus(identity.userAccount.status)) {
      throw new Error('local auth identity projection is invalid');
    }
    return {
      userId: identity.userAccount.id,
      email: identity.canonicalEmail,
      passwordHash: identity.passwordHash,
      status: identity.userAccount.status,
    };
  }

  async findLoginIdentityByUserId(
    userId: string,
  ): Promise<LoginIdentity | undefined> {
    const identity = await this.client.authIdentity.findFirst({
      where: { userAccountId: userId, provider: 'password' },
      select: {
        canonicalEmail: true,
        passwordHash: true,
        userAccount: { select: { status: true } },
      },
    });
    if (identity === null) return undefined;
    if (!isAccountStatus(identity.userAccount.status)) {
      throw new Error('local auth identity projection is invalid');
    }
    return {
      userId,
      email: identity.canonicalEmail,
      passwordHash: identity.passwordHash,
      status: identity.userAccount.status,
    };
  }

  async findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined> {
    const account = await this.client.userAccount.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (account === null) {
      return undefined;
    }
    if (!isAccountStatus(account.status)) {
      throw new Error('local account status projection is invalid');
    }
    return account.status;
  }

  async findActiveUsername(userId: string): Promise<string | undefined> {
    const account = await this.client.userAccount.findFirst({
      where: { id: userId, status: 'active' },
      select: { username: true },
    });
    return account === null ? undefined : account.username;
  }

  async createRefreshSession(
    input: CreateRefreshSessionInput,
  ): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const authorized = await authorizeMfaSession(
        transaction,
        input.userId,
        input.mfaProof,
        input.issuedAt,
      );
      if (!authorized) return false;
      await this.insertRefreshSession(transaction, input);
      return true;
    });
  }

  async findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined> {
    const token = await this.client.refreshToken.findUnique({
      where: { tokenHash },
    });
    return token === null ? undefined : this.refreshTokenRecord(token);
  }

  async rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<RefreshTokenRotationResult> {
    return authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows<RefreshTokenRow & { status: string }>(
        transaction,
        LOCK_REFRESH_TOKEN_SQL,
        [input.tokenId, input.tokenHash],
      );
      const row = rows[0];
      if (row === undefined) {
        return { kind: 'invalid', reason: 'missing' };
      }

      const record = this.refreshTokenRecord(row);
      if (record === undefined) {
        return { kind: 'invalid', reason: 'missing' };
      }
      if (row.status !== 'active') {
        return { kind: 'invalid', reason: 'inactive' };
      }
      if (record.revokedAt !== undefined) {
        await this.revokeFamily(transaction, record.familyId, input.now);
        return { kind: 'invalid', reason: 'revoked' };
      }
      if (record.usedAt !== undefined) {
        await this.revokeFamily(transaction, record.familyId, input.now);
        return { kind: 'invalid', reason: 'used' };
      }
      if (record.expiresAt.getTime() <= input.now.getTime()) {
        return { kind: 'invalid', reason: 'expired' };
      }

      await transaction.refreshToken.updateMany({
        where: { id: input.tokenId, usedAt: null, revokedAt: null },
        data: { usedAt: input.now },
      });
      await this.insertRefreshSession(transaction, {
        userId: record.userId,
        token: input.successor,
        issuedAt: input.now,
      });
      return { kind: 'rotated', userId: record.userId };
    });
  }

  async revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void> {
    await authTransaction(this.client, async (transaction) => {
      const rows = await authQueryRows(
        transaction,
        `
          SELECT family_id
          FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE
        `,
        [input.tokenHash],
      );
      const familyId = rows[0]?.family_id;
      if (typeof familyId !== 'string') {
        return;
      }
      await this.revokeFamily(transaction, familyId, input.now);
    });
  }

  /**
   * The Email Delivery Request rides the caller's open transaction, so a
   * failure here rolls back the mutation it serves (ADR-0074).
   */
  private async insertEmailDelivery(
    transaction: AuthTransactionClient,
    emailDelivery: InsertEmailDeliveryRequestInput | undefined,
  ): Promise<void> {
    if (emailDelivery !== undefined) {
      await this.emailDeliveryRequests.insert(
        transaction as unknown as EmailDeliveryTransaction,
        emailDelivery,
      );
    }
  }

  /** Stores only the token hash, on the client or inside a transaction. */
  private async insertRefreshSession(
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

  private refreshTokenRecord(
    row: RefreshTokenRow,
  ): RefreshTokenRecord | undefined {
    if (
      typeof row.id !== 'string' ||
      typeof row.familyId !== 'string' ||
      typeof row.userAccountId !== 'string' ||
      !(row.expiresAt instanceof Date) ||
      Number.isNaN(row.expiresAt.getTime()) ||
      (row.usedAt !== null && !(row.usedAt instanceof Date)) ||
      (row.revokedAt !== null && !(row.revokedAt instanceof Date))
    ) {
      return undefined;
    }
    return {
      tokenId: row.id,
      familyId: row.familyId,
      userId: row.userAccountId,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt === null ? undefined : row.usedAt,
      revokedAt: row.revokedAt === null ? undefined : row.revokedAt,
    };
  }

  private async revokeFamily(
    transaction: AuthTransactionClient,
    familyId: string,
    now: Date,
  ): Promise<void> {
    await transaction.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async close(): Promise<void> {
    if ('close' in this.client && typeof this.client.close === 'function') {
      await this.client.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
