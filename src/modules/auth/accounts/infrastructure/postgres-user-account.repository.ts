import { EmailDeliveryTransactionAdapter } from '@/modules/auth/email-delivery/infrastructure/email-delivery-transaction.adapter';
import { ulid } from 'ulid';

import type {
  LoginIdentity,
  RegisterLocalAccountInput,
  UserAccountRepositoryPort,
} from '@/modules/auth/accounts/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import type { EmailDeliveryRequestWriterPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository';
import {
  LOCK_PASSWORD_IDENTITY_SQL,
  insertEmailDelivery,
} from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import { AuthIdentityConflictError } from '@/modules/auth/shared/application/auth-identity-conflict.error';
import {
  type AuthRepositoryClient,
  authQueryRows,
  authTransaction,
  isUniqueViolation,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { isAccountStatus } from '@/modules/auth/shared/infrastructure/auth-row';

/**
 * One User Account: registration, the login-identity lookup, and the status
 * Bearer authorization reads.
 *
 * Registration writes the account, its Auth Identity, its first Verification
 * Token, and the Email Delivery Request as one transaction. The two statements
 * belonging to the Verification Token and the outbox stay here rather than
 * reaching another adapter, because a second transaction between them would
 * leave an account with no token to verify it.
 */
export class PostgresUserAccountRepository
  implements UserAccountRepositoryPort
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
        let userId: string;
        const existing = (
          await authQueryRows(transaction, LOCK_PASSWORD_IDENTITY_SQL, [
            input.email,
          ])
        )[0];
        if (existing === undefined) {
          userId = `usr_${ulid()}`;
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
        } else {
          // The mailbox's owner registering again takes the pending slot back
          // (ADR-0054): the registrant before them no longer holds the credential.
          if (
            existing.status !== 'pending_verification' ||
            typeof existing.id !== 'string'
          ) {
            throw new AuthIdentityConflictError();
          }
          userId = existing.id;
          await transaction.userAccount.update({
            where: { id: userId },
            data: { username: input.username, updatedAt: input.now },
          });
          await transaction.authIdentity.updateMany({
            where: { userAccountId: userId, provider: 'password' },
            data: { passwordHash: input.passwordHash, updatedAt: input.now },
          });
          await transaction.emailVerificationToken.updateMany({
            where: { userAccountId: userId, consumedAt: null },
            data: { consumedAt: input.now, consumedReason: 'superseded' },
          });
        }
        const recipientAllowed =
          input.emailDelivery === undefined ||
          (await this.emailDeliveryRequests.reserveAuthenticationEmailRecipient(
            new EmailDeliveryTransactionAdapter(transaction),
            { email: input.email, now: input.now },
          ));
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
          await insertEmailDelivery(
            transaction,
            this.emailDeliveryRequests,
            input.emailDelivery,
          );
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
}
