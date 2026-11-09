import { internalError } from '@/common/errors/app-error';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { AuthIdentityConflictError } from '@/modules/auth/shared/application/auth-identity-conflict.error';
import {
  type SessionAdmission,
  authorizeMfaSession,
} from '@/modules/auth/shared/infrastructure/auth-mfa-session.guard';
import {
  type AuthRepositoryClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
  isUniqueViolation,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import {
  insertEmailDelivery,
  insertRefreshSession,
  lockIssuableIdentity,
} from '@/modules/auth/shared/infrastructure/local-auth-statements';
import { insertWebSession } from '@/modules/auth/shared/infrastructure/web-session-statements';
import {
  type VerificationAccountFacts,
  type VerificationDecision,
  type VerificationTokenFacts,
  type VerificationTokenState,
  decideVerification,
} from '@/modules/auth/verification/application/verification-decision';
import type {
  ConsumeVerificationTokenInput,
  ResendVerificationTarget,
  RotateVerificationTokenInput,
  VerificationCredential,
  VerificationOutcome,
  VerificationTokenRepositoryPort,
} from '@/modules/auth/verification/application/verification-token-repository.port';
import type { IssuedWebSessionToken } from '@/modules/auth/web-sessions/application/web-session-token.port';

const INVALID: VerificationOutcome = { kind: 'invalid' };
const VERIFIED: VerificationOutcome = { kind: 'verified' };

type VerificationConsumedReason =
  | 'verified'
  | 'superseded'
  | 'password_attempts';

function isVerificationConsumedReason(
  value: unknown,
): value is VerificationConsumedReason {
  return (
    value === 'verified' ||
    value === 'superseded' ||
    value === 'password_attempts'
  );
}

interface LockedVerificationAccount extends VerificationAccountFacts {
  readonly id: string;
}

interface LockedVerificationToken {
  readonly id: string;
  readonly state: VerificationTokenState;
  readonly requiresProof: boolean;
  readonly signInClaimed: boolean;
  readonly browserBindingHash: string | null;
}

interface LockedVerificationState {
  readonly account: LockedVerificationAccount;
  readonly token: LockedVerificationToken;
}

function readVerificationAccount(
  row: Readonly<Record<string, unknown>> | undefined,
): LockedVerificationAccount | undefined {
  if (
    row === undefined ||
    typeof row['id'] !== 'string' ||
    (row['status'] !== 'pending_verification' && row['status'] !== 'active')
  ) {
    return undefined;
  }
  return { id: row['id'], status: row['status'] };
}

function readVerificationToken(
  row: Readonly<Record<string, unknown>> | undefined,
  now: Date,
): LockedVerificationToken | undefined {
  if (row === undefined || typeof row['id'] !== 'string') return undefined;

  const expiresAt = row['expires_at'];
  const consumedAt = row['consumed_at'];
  const consumedReason = row['consumed_reason'];
  const browserBindingHash = row['browser_binding_hash'];
  const signedInAt = row['signed_in_at'];
  const requiresProof = row['requires_password'];

  if (
    !(expiresAt instanceof Date) ||
    Number.isNaN(expiresAt.getTime()) ||
    (consumedAt !== null &&
      (!(consumedAt instanceof Date) || Number.isNaN(consumedAt.getTime()))) ||
    (consumedReason !== null &&
      !isVerificationConsumedReason(consumedReason)) ||
    (browserBindingHash !== null && typeof browserBindingHash !== 'string') ||
    (signedInAt !== null && !(signedInAt instanceof Date)) ||
    typeof requiresProof !== 'boolean' ||
    expiresAt.getTime() <= now.getTime()
  ) {
    return undefined;
  }

  const state =
    consumedAt === null && consumedReason === null
      ? 'open'
      : consumedAt instanceof Date && consumedReason === 'verified'
        ? 'verified'
        : 'spent';
  return {
    id: row['id'],
    state,
    requiresProof,
    signInClaimed: signedInAt !== null,
    browserBindingHash,
  };
}
const PASSWORD_REQUIRED: VerificationOutcome = { kind: 'password_required' };

/**
 * One Verification Token: rotation on resend, and consumption, whose outcome
 * carries the Verification Sign-in decision and its session.
 *
 * Consumption activates the User Account and writes either a Refresh Session or
 * a Web Session inside the transaction that consumed the token, so a failed
 * session write leaves the whole request retryable while the token is
 * unexpired. Those two statements reach their tables through the shared
 * statements rather than through the adapters that own them, which is what
 * keeps one claim, one session, and one verification in one commit.
 */
export class PostgresVerificationTokenRepository
  implements VerificationTokenRepositoryPort
{
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailOutbox: EmailOutboxPort,
  ) {}

  async rotateVerificationToken(
    input: RotateVerificationTokenInput,
  ): Promise<ResendVerificationTarget | undefined> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        // Lock order: account and password identity, then verification tokens (ADR-0107).
        const row = await lockIssuableIdentity(
          transaction,
          this.emailOutbox,
          input,
          'pending_verification',
        );
        if (row === undefined) {
          return undefined;
        }

        await transaction.emailVerificationToken.updateMany({
          where: { userAccountId: row.id, consumedAt: null },
          data: { consumedAt: input.now, consumedReason: 'superseded' },
        });
        await transaction.emailVerificationToken.create({
          data: {
            id: input.tokenId,
            userAccountId: row.id,
            tokenHash: input.tokenHash,
            expiresAt: input.tokenExpiresAt,
            createdAt: input.now,
            browserBindingHash: input.browserBindingHash ?? null,
            requiresPassword: input.requiresPassword,
          },
        });
        await insertEmailDelivery(
          transaction,
          this.emailOutbox,
          input.emailDelivery,
        );
        return { email: row.email };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthIdentityConflictError();
      }
      throw error;
    }
  }

  async consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationOutcome> {
    return authTransaction(this.client, async (transaction) => {
      const state = await this.lockVerificationState(transaction, input);
      if (state === undefined) return INVALID;

      const decision = await this.resolveVerificationDecision(
        transaction,
        input,
        state,
      );
      return this.executeVerificationDecision(
        transaction,
        input,
        state,
        decision,
      );
    });
  }

  private async lockVerificationState(
    transaction: AuthTransactionClient,
    input: ConsumeVerificationTokenInput,
  ): Promise<LockedVerificationState | undefined> {
    // Lock order: account, then verification token and any issued session (ADR-0107).
    const accountRows = await authQueryRows(
      transaction,
      `
        SELECT account.id, account.status
        FROM user_accounts account
        JOIN email_verification_tokens token
          ON token.user_account_id = account.id
        WHERE token.token_hash = $1
        FOR UPDATE OF account
      `,
      [input.tokenHash],
    );
    const account = readVerificationAccount(accountRows[0]);
    if (account === undefined) return undefined;

    const tokenRows = await authQueryRows(
      transaction,
      `
        SELECT id, expires_at, consumed_at, consumed_reason,
               browser_binding_hash, signed_in_at, requires_password
        FROM email_verification_tokens
        WHERE user_account_id = $1 AND token_hash = $2
        FOR UPDATE
      `,
      [account.id, input.tokenHash],
    );
    const token = readVerificationToken(tokenRows[0], input.now);
    return token === undefined ? undefined : { account, token };
  }

  private async resolveVerificationDecision(
    transaction: AuthTransactionClient,
    input: ConsumeVerificationTokenInput,
    state: LockedVerificationState,
  ): Promise<Exclude<VerificationDecision, { readonly kind: 'proof_check' }>> {
    const accountFacts: VerificationAccountFacts = {
      status: state.account.status,
    };
    const tokenFacts: VerificationTokenFacts = {
      state: state.token.state,
      requiresProof: state.token.requiresProof,
      proofVerified: undefined,
      browserBindingMatches:
        input.browserBindingHash !== undefined &&
        state.token.browserBindingHash === input.browserBindingHash,
      signInClaimed: state.token.signInClaimed,
    };
    const decision = decideVerification(accountFacts, tokenFacts);
    if (decision.kind !== 'proof_check') return decision;

    const proofVerified = await this.holdsVerifiedPassword(
      transaction,
      state.account.id,
      input.verifiedPasswordHash,
    );
    const resolved = decideVerification(accountFacts, {
      ...tokenFacts,
      proofVerified,
    });
    if (resolved.kind === 'proof_check') {
      throw internalError('Verification proof check did not resolve');
    }
    return resolved;
  }

  private async executeVerificationDecision(
    transaction: AuthTransactionClient,
    input: ConsumeVerificationTokenInput,
    state: LockedVerificationState,
    decision: Exclude<VerificationDecision, { readonly kind: 'proof_check' }>,
  ): Promise<VerificationOutcome> {
    switch (decision.kind) {
      case 'invalid':
        return INVALID;
      case 'proof_required':
        return PASSWORD_REQUIRED;
      case 'verified':
        return VERIFIED;
      case 'verify': {
        const activated = await this.consumeAndActivatePendingAccount(
          transaction,
          state.account.id,
          state.token.id,
          input.now,
        );
        return activated ? VERIFIED : INVALID;
      }
      case 'sign_in': {
        if (decision.activateAccount) {
          const activated = await this.consumeAndActivatePendingAccount(
            transaction,
            state.account.id,
            state.token.id,
            input.now,
          );
          if (!activated) return INVALID;
        }
        return this.claimVerificationSignIn(
          transaction,
          input,
          state.account.id,
          state.token.id,
        );
      }
    }
  }

  private async consumeAndActivatePendingAccount(
    transaction: AuthTransactionClient,
    accountId: string,
    tokenId: string,
    now: Date,
  ): Promise<boolean> {
    const consumed = await transaction.emailVerificationToken.updateMany({
      where: { id: tokenId, consumedAt: null },
      data: { consumedAt: now, consumedReason: 'verified' },
    });
    if (consumed.count === 0) return false;

    const activated = await transaction.userAccount.updateMany({
      where: { id: accountId, status: 'pending_verification' },
      data: { status: 'active', updatedAt: now },
    });
    return activated.count > 0;
  }

  private async claimVerificationSignIn(
    transaction: AuthTransactionClient,
    input: ConsumeVerificationTokenInput,
    accountId: string,
    tokenId: string,
  ): Promise<VerificationOutcome> {
    // The admission login needs no proof to offer. An enabled factor verifies
    // the email without claiming the token's one Verification Sign-in (ADR-0054).
    const admission = await authorizeMfaSession(
      transaction,
      accountId,
      undefined,
      input.now,
    );
    if (admission === undefined) return VERIFIED;

    // The conditional update keeps concurrent requests from claiming twice.
    const claimed = await transaction.emailVerificationToken.updateMany({
      where: {
        id: tokenId,
        signedInAt: null,
        consumedReason: 'verified',
      },
      data: { signedInAt: input.now },
    });
    if (claimed.count === 0) return VERIFIED;

    if (input.signInSession.kind === 'refresh') {
      await insertRefreshSession(
        transaction,
        {
          userId: accountId,
          token: input.signInSession.token,
          issuedAt: input.signInSession.issuedAt,
        },
        admission,
      );
    } else {
      await this.insertWebSession(
        transaction,
        accountId,
        {
          sessionId: input.signInSession.sessionId,
          token: input.signInSession.token,
          issuedAt: input.signInSession.issuedAt,
        },
        admission,
      );
    }
    return { kind: 'signed_in', userId: accountId };
  }

  async readVerificationCredential(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<VerificationCredential | undefined> {
    const rows = await authQueryRows(
      this.client,
      `
        SELECT token.requires_password, identity.password_hash
        FROM email_verification_tokens token
        JOIN user_accounts account ON account.id = token.user_account_id
        JOIN auth_identities identity
          ON identity.user_account_id = account.id AND identity.provider = 'password'
        WHERE token.token_hash = $1
          AND token.consumed_at IS NULL
          AND token.expires_at > $2
          AND account.status = 'pending_verification'
      `,
      [input.tokenHash, input.now],
    );
    const row = rows[0];
    if (
      row === undefined ||
      typeof row['requires_password'] !== 'boolean' ||
      typeof row['password_hash'] !== 'string'
    ) {
      return undefined;
    }
    return {
      requiresPassword: row['requires_password'],
      passwordHash: row['password_hash'],
    };
  }

  async recordWrongVerificationPassword(input: {
    readonly tokenHash: string;
    readonly now: Date;
    readonly limit: number;
  }): Promise<void> {
    // One statement, so concurrent wrong passwords each count once and exactly
    // one of them spends the token.
    await authQueryRows(
      this.client,
      `
        UPDATE email_verification_tokens
        SET password_failures = password_failures + 1,
            consumed_at = CASE WHEN password_failures + 1 >= $3 THEN $2::timestamptz END,
            consumed_reason = CASE WHEN password_failures + 1 >= $3 THEN 'password_attempts' END
        WHERE token_hash = $1 AND consumed_at IS NULL
        RETURNING id
      `,
      [input.tokenHash, input.now, input.limit],
    );
  }

  /** The stored hash, read under the account lock, is the one the caller verified. */
  private async holdsVerifiedPassword(
    transaction: AuthTransactionClient,
    accountId: string,
    verifiedPasswordHash: string | undefined,
  ): Promise<boolean> {
    if (verifiedPasswordHash === undefined) return false;
    const rows = await authQueryRows(
      transaction,
      `
        SELECT password_hash FROM auth_identities
        WHERE user_account_id = $1 AND provider = 'password'
      `,
      [accountId],
    );
    return rows[0]?.['password_hash'] === verifiedPasswordHash;
  }

  /**
   * The Web Session a Verification Sign-in won, written in this claim's
   * transaction. `PostgresWebSessionRepository` owns the same row for login
   * creation, which has no transaction of its own to join.
   */
  private async insertWebSession(
    transaction: AuthTransactionClient,
    userId: string,
    session: {
      readonly sessionId: string;
      readonly token: IssuedWebSessionToken;
      readonly issuedAt: Date;
    },
    admission: SessionAdmission,
  ): Promise<void> {
    await insertWebSession(
      transaction,
      {
        id: session.sessionId,
        userId,
        tokenHash: session.token.hash,
        createdAt: session.issuedAt,
        expiresAt: session.token.expiresAt,
      },
      admission,
    );
  }
}
