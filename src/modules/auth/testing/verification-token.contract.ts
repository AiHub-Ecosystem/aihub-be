/**
 * Port contract suite for VerificationTokenRepositoryPort.
 *
 * Pattern (for other auth fakes): write the scenarios once in a function that
 * takes a harness (repo factory + seeding helpers). Run it in the unit lane
 * against the in-memory adapter and in `pnpm test:db` against the Postgres
 * repository, so the two implementations cannot drift.
 */
import type { VerificationTokenRepositoryPort } from '@/modules/auth/verification/application/verification-token-repository.port';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { ulid } from 'ulid';

export interface VerificationTokenContractHarness {
  readonly userId: string;
  readonly email: string;
  readonly binding: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly expiredAt: Date;
  createRepo(): VerificationTokenRepositoryPort & {
    failSessionWrite?: boolean;
  };
  reset(): Promise<void>;
  seedAccount(status: string): Promise<void>;
  insertToken(options: {
    readonly hash: string;
    readonly expiresAt?: Date;
    readonly consumedAt?: Date;
    readonly consumedReason?: 'verified' | 'superseded';
    readonly bindingHash?: string;
    readonly signedInAt?: Date;
  }): Promise<void>;
  setAccountStatus(userId: string, status: string): Promise<void>;
  getTokenSignedInAt(hash: string): Promise<Date | undefined>;
  /** Enrols the seeded account in an enabled second factor. */
  enableSecondFactor(): Promise<void>;
  /** How many Refresh Sessions and Web Sessions the seeded account holds. */
  sessionCount(): Promise<number>;
  setFailSessionWrite?(value: boolean): void;
}

function issuedRefresh(expiresAt: Date): IssuedRefreshToken {
  return {
    id: `rft_${ulid()}`,
    familyId: `rfs_${ulid()}`,
    raw: 'raw-refresh-token',
    hash: 'c'.repeat(64),
    expiresAt,
  };
}

export function verificationTokenRepositoryContract(
  harness: VerificationTokenContractHarness,
): void {
  const { userId, binding, now, expiresAt, expiredAt } = harness;

  let repo: ReturnType<VerificationTokenContractHarness['createRepo']>;

  beforeEach(async () => {
    await harness.reset();
    await harness.seedAccount('pending_verification');
    repo = harness.createRepo();
    harness.setFailSessionWrite?.(false);
  });

  it('invalid for unknown token', async () => {
    const outcome = await repo.consumeVerificationToken({
      tokenHash: 'nope',
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('expired token is invalid', async () => {
    const hash = 'a'.repeat(64);
    await harness.insertToken({
      hash,
      expiresAt: expiredAt,
      bindingHash: binding,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: binding,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('superseded token is invalid', async () => {
    const hash = 'b'.repeat(64);
    await harness.insertToken({
      hash,
      expiresAt,
      consumedAt: now,
      consumedReason: 'superseded',
      bindingHash: binding,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: binding,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('verifies a pending account (no binding) -> verified', async () => {
    const hash = 'c'.repeat(64);
    await harness.insertToken({ hash, expiresAt });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'verified' });
    // account status check left to implementation
  });

  it('second verification of consumed token (active account, unbound) -> verified', async () => {
    const hash = 'd'.repeat(64);
    await harness.insertToken({
      hash,
      expiresAt,
      consumedAt: now,
      consumedReason: 'verified',
    });
    await harness.setAccountStatus(userId, 'active');
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'verified' });
  });

  it('bound sign-in returns signed_in and claims signedInAt', async () => {
    const hash = 'e'.repeat(64);
    await harness.insertToken({ hash, expiresAt, bindingHash: binding });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: binding,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'signed_in', userId });
    expect(await harness.getTokenSignedInAt(hash)).toBeDefined();
  });

  it('unbound request on bound token -> verified only', async () => {
    const hash = 'f'.repeat(64);
    await harness.insertToken({ hash, expiresAt, bindingHash: binding });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'verified' });
    expect(await harness.getTokenSignedInAt(hash)).toBeUndefined();
  });

  it('second sign-in claim -> verified (already spent)', async () => {
    const hash = '1'.repeat(64);
    await harness.insertToken({
      hash,
      expiresAt,
      consumedAt: now,
      consumedReason: 'verified',
      bindingHash: binding,
      signedInAt: now,
    });
    await harness.setAccountStatus(userId, 'active');
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: binding,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });
    expect(outcome).toEqual({ kind: 'verified' });
  });

  it.each([
    [
      'refresh',
      (): Parameters<
        typeof repo.consumeVerificationToken
      >[0]['signInSession'] => ({
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      }),
    ],
    [
      'web-session',
      (): Parameters<
        typeof repo.consumeVerificationToken
      >[0]['signInSession'] => ({
        kind: 'web-session',
        sessionId: 'sess_factor',
        token: { raw: 'r', hash: 'wh_factor', expiresAt },
        issuedAt: now,
      }),
    ],
  ])(
    'a %s sign-in for an account that enrolled a second factor verifies but creates no session',
    async (_kind, signInSession) => {
      const hash = '3'.repeat(64);
      await harness.insertToken({
        hash,
        expiresAt,
        consumedAt: now,
        consumedReason: 'verified',
        bindingHash: binding,
      });
      await harness.setAccountStatus(userId, 'active');
      await harness.enableSecondFactor();

      const outcome = await repo.consumeVerificationToken({
        tokenHash: hash,
        browserBindingHash: binding,
        now,
        signInSession: signInSession(),
      });

      expect(outcome).toEqual({ kind: 'verified' });
      expect(await harness.sessionCount()).toBe(0);
      // No sign-in happened, so the token's one sign-in is not spent.
      expect(await harness.getTokenSignedInAt(hash)).toBeUndefined();
    },
  );

  it('an account that enrolled a factor before its first verification verifies without a session', async () => {
    const hash = '4'.repeat(64);
    await harness.insertToken({ hash, expiresAt, bindingHash: binding });
    await harness.enableSecondFactor();

    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: binding,
      now,
      signInSession: {
        kind: 'refresh',
        token: issuedRefresh(expiresAt),
        issuedAt: now,
      },
    });

    expect(outcome).toEqual({ kind: 'verified' });
    expect(await harness.sessionCount()).toBe(0);
    expect(await harness.getTokenSignedInAt(hash)).toBeUndefined();
  });

  it('failed session write rolls back the claim', async () => {
    const hash = '2'.repeat(64);
    await harness.insertToken({ hash, expiresAt, bindingHash: binding });
    harness.setFailSessionWrite?.(true);
    await expect(
      repo.consumeVerificationToken({
        tokenHash: hash,
        browserBindingHash: binding,
        now,
        signInSession: {
          kind: 'web-session',
          sessionId: 'sess_1',
          token: { raw: 'r', hash: 'wh_1', expiresAt },
          issuedAt: now,
        },
      }),
    ).rejects.toThrow();
    expect(await harness.getTokenSignedInAt(hash)).toBeUndefined();
    harness.setFailSessionWrite?.(false);
  });
}
