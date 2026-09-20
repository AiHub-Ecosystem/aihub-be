import type { LocalAccountStatus } from '../domain/local-auth';
import type { IssuedRefreshToken } from './refresh-token.port';

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

export interface PasswordResetTarget {
  readonly email: string;
}

export interface LoginIdentity {
  readonly userId: string;
  readonly passwordHash: string;
  readonly status: LocalAccountStatus;
}

export interface RefreshTokenRecord {
  readonly tokenId: string;
  readonly familyId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | undefined;
  readonly revokedAt: Date | undefined;
}

export type RefreshTokenFailureReason =
  | 'missing'
  | 'inactive'
  | 'expired'
  | 'used'
  | 'revoked';

export type RefreshTokenRotationResult =
  | { readonly kind: 'rotated'; readonly userId: string }
  | {
      readonly kind: 'invalid';
      readonly reason: RefreshTokenFailureReason;
    };

export type PasswordResetResult =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'invalid';
      readonly reason: 'missing' | 'inactive' | 'expired' | 'consumed';
    };

export type PasswordResetTokenCheckResult =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'invalid';
      readonly reason: 'missing' | 'inactive' | 'expired' | 'consumed';
    };

export interface CreateRefreshSessionInput {
  readonly userId: string;
  readonly token: IssuedRefreshToken;
  readonly issuedAt: Date;
}

export interface RotateRefreshTokenInput {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly successor: IssuedRefreshToken;
  readonly now: Date;
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
  issuePasswordResetToken(input: {
    readonly email: string;
    readonly tokenId: string;
    readonly tokenHash: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
  }): Promise<PasswordResetTarget | undefined>;
  consumeVerificationToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<boolean>;
  checkPasswordResetToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<PasswordResetTokenCheckResult>;
  consumePasswordReset(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<PasswordResetResult>;
  findLoginIdentityByEmail(email: string): Promise<LoginIdentity | undefined>;
  findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined>;
  createRefreshSession(input: CreateRefreshSessionInput): Promise<void>;
  findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined>;
  rotateRefreshToken(
    input: RotateRefreshTokenInput,
  ): Promise<RefreshTokenRotationResult>;
  revokeRefreshFamilyByTokenHash(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<void>;
}

export class AuthIdentityConflictError extends Error {
  constructor() {
    super('local auth identity is unavailable');
    this.name = 'AuthIdentityConflictError';
  }
}

export type PersistedLocalAccountStatus = LocalAccountStatus;

export const LOCAL_AUTH_REPOSITORY = Symbol('LOCAL_AUTH_REPOSITORY');
