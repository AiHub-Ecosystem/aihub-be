import { ulid } from 'ulid';

import { AuthIdentityConflictError } from '@/modules/auth/application/auth-identity-conflict.error';
import type {
  EmailDeliveryRequestWriterPort,
  EmailDeliveryTransaction,
} from '@/modules/auth/application/email-delivery-request.port';
import type {
  LoginIdentity,
  RegisterLocalAccountInput,
  UserAccountRepositoryPort,
} from '@/modules/auth/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import {
  type AuthRepositoryClient,
  authTransaction,
  isUniqueViolation,
} from './auth-prisma';
import { isAccountStatus } from './auth-row';
import { insertEmailDelivery } from './local-auth-statements';
import { PostgresEmailDeliveryRequestRepository } from './postgres-email-delivery-request.repository';

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
