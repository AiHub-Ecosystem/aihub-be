export interface DisableUserAccountInput {
  readonly user: string;
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface RevokedSessionsCount {
  readonly refreshTokens: number;
  readonly webSessions: number;
  readonly verificationTokens: number;
  readonly passwordResetTokens: number;
}

export type DisableUserAccountResult =
  | {
      readonly kind: 'disabled';
      readonly userId: string;
      readonly username: string;
      readonly revokedSessions: RevokedSessionsCount;
    }
  | {
      readonly kind: 'unchanged';
      readonly userId: string;
      readonly username: string;
    }
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'actor_invalid' };

export interface RestoreUserAccountInput {
  readonly user: string;
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export type RestoreUserAccountResult =
  | {
      readonly kind: 'restored';
      readonly userId: string;
      readonly username: string;
    }
  | {
      readonly kind: 'unchanged';
      readonly userId: string;
      readonly username: string;
    }
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'actor_invalid' };

export interface RevokeAllRefreshSessionsInput {
  readonly actorUsername: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export type RevokeAllRefreshSessionsResult =
  | {
      readonly kind: 'revoked';
      readonly revokedCount: number;
    }
  | { readonly kind: 'actor_invalid' };

export interface UserAccountStatusPort {
  disableUserAccount(
    input: DisableUserAccountInput,
  ): Promise<DisableUserAccountResult>;
  restoreUserAccount(
    input: RestoreUserAccountInput,
  ): Promise<RestoreUserAccountResult>;
  revokeAllRefreshSessions(
    input: RevokeAllRefreshSessionsInput,
  ): Promise<RevokeAllRefreshSessionsResult>;
  close(): Promise<void>;
}
