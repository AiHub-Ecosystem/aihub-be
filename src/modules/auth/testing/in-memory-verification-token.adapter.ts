import { AuthIdentityConflictError } from '@/modules/auth/application/auth-identity-conflict.error';
import type {
  ConsumeVerificationTokenInput,
  ResendVerificationTarget,
  RotateVerificationTokenInput,
  VerificationOutcome,
  VerificationTokenRepositoryPort,
} from '@/modules/auth/application/verification-token-repository.port';
import type {
  InMemoryAuthState,
  InMemoryVerificationToken,
} from './in-memory-auth.state';

const INVALID: VerificationOutcome = { kind: 'invalid' };
const VERIFIED: VerificationOutcome = { kind: 'verified' };

export class InMemoryVerificationTokenAdapter
  implements VerificationTokenRepositoryPort
{
  constructor(private readonly state: InMemoryAuthState) {}

  async rotateVerificationToken(
    input: RotateVerificationTokenInput,
  ): Promise<ResendVerificationTarget | undefined> {
    const account = [...this.state.accounts.values()].find(
      (candidate) => candidate.email === input.email,
    );
    if (account === undefined || account.status !== 'pending_verification') {
      return undefined;
    }
    if (this.state.verificationTokens.has(input.tokenHash)) {
      throw new AuthIdentityConflictError();
    }

    for (const token of this.state.verificationTokens.values()) {
      if (token.userId === account.userId && token.consumedAt === undefined) {
        token.consumedAt = input.now;
        token.consumedReason = 'superseded';
      }
    }
    this.state.verificationTokens.set(input.tokenHash, {
      tokenId: input.tokenId,
      userId: account.userId,
      expiresAt: input.tokenExpiresAt,
      browserBindingHash: input.browserBindingHash,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    return { email: account.email };
  }

  async consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationOutcome> {
    const token = this.state.verificationTokens.get(input.tokenHash);
    if (token === undefined) {
      return INVALID;
    }
    const account = this.state.accounts.get(token.userId);
    if (
      account === undefined ||
      (account.status !== 'pending_verification' && account.status !== 'active')
    ) {
      return INVALID;
    }
    if (token.expiresAt.getTime() <= input.now.getTime()) {
      return INVALID;
    }

    if (account.status === 'active') {
      return token.consumedReason === 'verified'
        ? this.signInIfBound(token, input)
        : INVALID;
    }

    if (token.consumedAt !== undefined) {
      return INVALID;
    }
    token.consumedAt = input.now;
    token.consumedReason = 'verified';
    account.status = 'active';
    return this.signInIfBound(token, input);
  }

  private signInIfBound(
    token: InMemoryVerificationToken,
    input: ConsumeVerificationTokenInput,
  ): VerificationOutcome {
    // ADR-0054: only the bound browser, only once.
    if (
      input.browserBindingHash === undefined ||
      token.browserBindingHash !== input.browserBindingHash ||
      token.signedInAt !== undefined
    ) {
      return VERIFIED;
    }

    token.signedInAt = input.now;
    this.state.refreshTokens.set(input.signInSession.token.hash, {
      tokenId: input.signInSession.token.id,
      familyId: input.signInSession.token.familyId,
      userId: token.userId,
      expiresAt: input.signInSession.token.expiresAt,
      usedAt: undefined,
      revokedAt: undefined,
    });
    return { kind: 'signed_in', userId: token.userId };
  }
}
