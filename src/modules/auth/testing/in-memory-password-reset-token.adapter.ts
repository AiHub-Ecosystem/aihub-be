import type {
  IssuePasswordResetTokenInput,
  PasswordResetResult,
  PasswordResetTarget,
  PasswordResetTokenCheckResult,
  PasswordResetTokenInvalidReason,
  PasswordResetTokenRepositoryPort,
} from '@/modules/auth/application/password-reset-token-repository.port';
import type { InMemoryAuthState } from './in-memory-auth.state';

type Inspection =
  | { readonly kind: 'valid'; readonly userId: string }
  | {
      readonly kind: 'invalid';
      readonly reason: PasswordResetTokenInvalidReason;
    };

export class InMemoryPasswordResetTokenAdapter
  implements PasswordResetTokenRepositoryPort
{
  constructor(private readonly state: InMemoryAuthState) {}

  async issuePasswordResetToken(
    input: IssuePasswordResetTokenInput,
  ): Promise<PasswordResetTarget | undefined> {
    const account = [...this.state.accounts.values()].find(
      (candidate) => candidate.email === input.email,
    );
    if (account === undefined || account.status !== 'active') {
      return undefined;
    }

    for (const token of this.state.passwordResetTokens.values()) {
      if (token.userId === account.userId && token.consumedAt === undefined) {
        token.consumedAt = input.now;
      }
    }
    this.state.passwordResetTokens.set(input.tokenHash, {
      tokenId: input.tokenId,
      userId: account.userId,
      expiresAt: input.tokenExpiresAt,
      consumedAt: undefined,
    });
    if (input.emailDelivery !== undefined) {
      this.state.emailDeliveryRequests.push(input.emailDelivery);
    }
    return { email: account.email };
  }

  async checkPasswordResetToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<PasswordResetTokenCheckResult> {
    const inspection = this.inspect(input.tokenHash, input.now);
    return inspection.kind === 'valid' ? { kind: 'valid' } : inspection;
  }

  async consumePasswordReset(input: {
    readonly tokenHash: string;
    readonly passwordHash: string;
    readonly now: Date;
  }): Promise<PasswordResetResult> {
    const inspection = this.inspect(input.tokenHash, input.now);
    if (inspection.kind === 'invalid') {
      return inspection;
    }

    const account = this.state.accounts.get(inspection.userId);
    if (account === undefined) {
      return { kind: 'invalid', reason: 'missing' };
    }
    account.passwordHash = input.passwordHash;
    for (const token of this.state.passwordResetTokens.values()) {
      if (token.userId === account.userId) {
        token.consumedAt = input.now;
      }
    }
    for (const [hash, session] of this.state.refreshTokens) {
      if (
        session.userId === account.userId &&
        session.revokedAt === undefined
      ) {
        this.state.refreshTokens.set(hash, {
          ...session,
          revokedAt: input.now,
        });
      }
    }
    return { kind: 'reset' };
  }

  private inspect(tokenHash: string, now: Date): Inspection {
    const token = this.state.passwordResetTokens.get(tokenHash);
    if (token === undefined) {
      return { kind: 'invalid', reason: 'missing' };
    }
    const account = this.state.accounts.get(token.userId);
    if (account === undefined || account.status !== 'active') {
      return { kind: 'invalid', reason: 'inactive' };
    }
    if (token.consumedAt !== undefined) {
      return { kind: 'invalid', reason: 'consumed' };
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      return { kind: 'invalid', reason: 'expired' };
    }
    return { kind: 'valid', userId: token.userId };
  }
}
