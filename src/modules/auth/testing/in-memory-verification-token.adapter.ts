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
  /** Fails the session write inside the claim, as a durable store outage would. */
  failSessionWrite = false;

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
    if (input.emailDelivery !== undefined) {
      this.state.emailDeliveryRequests.push(input.emailDelivery);
    }
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

  /**
   * The one claim a verification token has, whatever session kind asked for it.
   * Setting `signedInAt` before the write is what makes a second request — and
   * a request for the other session kind — see the token as already spent, so
   * "at most one session in total" is a property of this state rather than of
   * two code paths agreeing. A failed write releases the claim, mirroring the
   * rollback Postgres does with the whole transaction.
   */
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
    try {
      if (input.signInSession.kind === 'refresh') {
        const refresh = input.signInSession;
        this.state.refreshTokens.set(refresh.token.hash, {
          tokenId: refresh.token.id,
          familyId: refresh.token.familyId,
          userId: token.userId,
          expiresAt: refresh.token.expiresAt,
          usedAt: undefined,
          revokedAt: undefined,
        });
      } else {
        if (this.failSessionWrite) {
          throw new Error('durable store unavailable');
        }
        const session = input.signInSession;
        this.state.webSessions.set(session.token.hash, {
          sessionId: session.sessionId,
          userId: token.userId,
          tokenHash: session.token.hash,
          createdAt: session.issuedAt,
          expiresAt: session.token.expiresAt,
          lastRenewedAt: session.issuedAt,
          revokedAt: undefined,
        });
      }
    } catch (error) {
      token.signedInAt = undefined;
      throw error;
    }

    return { kind: 'signed_in', userId: token.userId };
  }
}
