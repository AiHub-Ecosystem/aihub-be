import type { MfaSessionProof } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import type { IssuedRefreshToken } from './refresh-token.port';

/** What one stored Refresh Session needs, however its sign-in was proved. */
export interface RefreshSessionRowInput {
  readonly userId: string;
  readonly token: IssuedRefreshToken;
  readonly issuedAt: Date;
}

export interface CreateRefreshSessionInput extends RefreshSessionRowInput {
  /**
   * The password hash the sign-in verified. The insert refuses when the stored
   * hash is no longer this one, because a reset replaced the password after the
   * check (ADR-0025).
   */
  readonly expectedPasswordHash: string;
  readonly mfaProof?: MfaSessionProof;
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

export interface RotateRefreshTokenInput {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly successor: IssuedRefreshToken;
  readonly now: Date;
}

/**
 * One Refresh Session family: creation, lookup, rotation, and revocation
 * (ADR-0024).
 *
 * `rotateRefreshToken` consumes the presented token and stores its successor
 * as one durable step, and revokes the whole family when a used or revoked
 * token is presented.
 */
export interface RefreshSessionRepositoryPort {
  createRefreshSession(input: CreateRefreshSessionInput): Promise<boolean>;
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

export const REFRESH_SESSION_REPOSITORY = Symbol('REFRESH_SESSION_REPOSITORY');
