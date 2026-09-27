export interface PasswordResetTarget {
  readonly email: string;
}

export type PasswordResetTokenInvalidReason =
  | 'missing'
  | 'inactive'
  | 'expired'
  | 'consumed';

export type PasswordResetResult =
  | { readonly kind: 'reset' }
  | {
      readonly kind: 'invalid';
      readonly reason: PasswordResetTokenInvalidReason;
    };

export type PasswordResetTokenCheckResult =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'invalid';
      readonly reason: PasswordResetTokenInvalidReason;
    };

export interface IssuePasswordResetTokenInput {
  readonly email: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenExpiresAt: Date;
  readonly now: Date;
}

/**
 * One Password Reset Token: issue, check, and the reset that consumes it.
 *
 * `consumePasswordReset` changes the password, consumes every open reset
 * token, and revokes every Refresh Session of the account as one durable
 * step (ADR-0025).
 */
export interface PasswordResetTokenRepositoryPort {
  issuePasswordResetToken(
    input: IssuePasswordResetTokenInput,
  ): Promise<PasswordResetTarget | undefined>;
  checkPasswordResetToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<PasswordResetTokenCheckResult>;
  consumePasswordReset(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<PasswordResetResult>;
}

export const PASSWORD_RESET_TOKEN_REPOSITORY = Symbol(
  'PASSWORD_RESET_TOKEN_REPOSITORY',
);
