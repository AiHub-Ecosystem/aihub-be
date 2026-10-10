import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';

import type { InsertEmailDeliveryRequestInput } from './email-delivery-request.port';

export interface RegisterLocalAccountInput {
  readonly email: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenExpiresAt: Date;
  /** Hash of the requesting browser's Signup Browser Binding, if any. */
  readonly browserBindingHash?: string;
  readonly now: Date;
  /** Written in the same transaction as the account, or nowhere. */
  readonly emailDelivery?: InsertEmailDeliveryRequestInput;
}

export interface LoginIdentity {
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: LocalAccountStatus;
}

/**
 * One User Account: registration, the login-identity lookup, and the current
 * status Bearer authorization checks.
 *
 * `register` creates the account, its Auth Identity, and its first
 * Verification Token as one durable step, and throws
 * `AuthIdentityConflictError` when the email or username is taken.
 */
export interface UserAccountRepositoryPort {
  register(input: RegisterLocalAccountInput): Promise<void>;
  findLoginIdentityByEmail(email: string): Promise<LoginIdentity | undefined>;
  findLoginIdentityByUserId(userId: string): Promise<LoginIdentity | undefined>;
  findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined>;
  findActiveUsername(userId: string): Promise<string | undefined>;
}

export const USER_ACCOUNT_REPOSITORY = Symbol('USER_ACCOUNT_REPOSITORY');
