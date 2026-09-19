import type { LocalAccountStatus } from '../domain/local-auth';

export interface RegisterLocalAccountInput {
  readonly email: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenExpiresAt: Date;
  readonly now: Date;
}

export interface ResendVerificationTarget {
  readonly email: string;
}

export interface LoginIdentity {
  readonly userId: string;
  readonly passwordHash: string;
  readonly status: LocalAccountStatus;
}

export interface LocalAuthRepositoryPort {
  register(input: RegisterLocalAccountInput): Promise<void>;
  rotateVerificationToken(input: {
    readonly email: string;
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
  }): Promise<ResendVerificationTarget | undefined>;
  consumeVerificationToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  findLoginIdentityByEmail(email: string): Promise<LoginIdentity | undefined>;
  findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined>;
}

export class AuthIdentityConflictError extends Error {
  constructor() {
    super('local auth identity is unavailable');
    this.name = 'AuthIdentityConflictError';
  }
}

export type PersistedLocalAccountStatus = LocalAccountStatus;

export const LOCAL_AUTH_REPOSITORY = Symbol('LOCAL_AUTH_REPOSITORY');
