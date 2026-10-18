import type { InMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';
import {
  createInMemoryAuthState,
  seedAccount,
} from '@/modules/auth/testing/in-memory-auth.state';
import type { VerificationTokenRepositoryPort } from '@/modules/auth/verification/application/verification-token-repository.port';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';

export interface VerificationTokenContractHarness {
  createRepo(
    state: InMemoryAuthState,
  ): VerificationTokenRepositoryPort & { failSessionWrite?: boolean };
  reset(state: InMemoryAuthState): void;
}

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EMAIL = 'verify@example.com';
const BINDING = 'binding-hash';

function issuedRefresh(): IssuedRefreshToken {
  return {
    id: 'rt_1',
    familyId: 'fam_1',
    raw: 'raw',
    hash: 'rhash_1',
    expiresAt: EXPIRES_AT,
  };
}

export function verificationTokenRepositoryContract(
  harness: VerificationTokenContractHarness,
): void {
  let state: InMemoryAuthState;
  let repo: ReturnType<VerificationTokenContractHarness['createRepo']>;

  beforeEach(() => {
    state = createInMemoryAuthState();
    state.reset();
    seedAccount(state, {
      userId: 'usr_1',
      email: EMAIL,
      passwordHash: 'hash',
      status: 'pending_verification',
    });
    repo = harness.createRepo(state);
  });

  it('invalid for unknown token', async () => {
    const outcome = await repo.consumeVerificationToken({
      tokenHash: 'nope',
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('expired token is invalid', async () => {
    const hash = 'expired-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't1',
      userId: 'usr_1',
      expiresAt: new Date('2026-09-22T00:00:00.000Z'),
      browserBindingHash: BINDING,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: BINDING,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('superseded token is invalid', async () => {
    const hash = 'superseded-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't2',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: BINDING,
      consumedAt: NOW,
      consumedReason: 'superseded',
      signedInAt: undefined,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: BINDING,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'invalid' });
  });

  it('verifies a pending account (no binding) -> verified', async () => {
    const hash = 'verify-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't3',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: undefined,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'verified' });
    expect(state.accounts.get('usr_1')?.status).toBe('active');
  });

  it('second verification of consumed token (active account, unbound) -> verified', async () => {
    const hash = 'consumed-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't4',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: undefined,
      consumedAt: NOW,
      consumedReason: 'verified',
      signedInAt: undefined,
    });
    // account already active
    state.accounts.get('usr_1')!.status = 'active';
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'verified' });
  });

  it('bound sign-in returns signed_in and claims signedInAt', async () => {
    const hash = 'bound-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't5',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: BINDING,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: BINDING,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'signed_in', userId: 'usr_1' });
    expect(state.verificationTokens.get(hash)?.signedInAt).toBeDefined();
  });

  it('unbound request on bound token -> verified only', async () => {
    const hash = 'bound-hash2';
    state.verificationTokens.set(hash, {
      tokenId: 't6',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: BINDING,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'verified' });
    expect(state.verificationTokens.get(hash)?.signedInAt).toBeUndefined();
  });

  it('second sign-in claim -> verified (already spent)', async () => {
    const hash = 'spent-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't7',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: BINDING,
      consumedAt: NOW,
      consumedReason: 'verified',
      signedInAt: NOW,
    });
    state.accounts.get('usr_1')!.status = 'active';
    const outcome = await repo.consumeVerificationToken({
      tokenHash: hash,
      browserBindingHash: BINDING,
      now: NOW,
      signInSession: { kind: 'refresh', token: issuedRefresh(), issuedAt: NOW },
    });
    expect(outcome).toEqual({ kind: 'verified' });
  });

  it('failed session write rolls back the claim', async () => {
    const hash = 'fail-write-hash';
    state.verificationTokens.set(hash, {
      tokenId: 't8',
      userId: 'usr_1',
      expiresAt: EXPIRES_AT,
      browserBindingHash: BINDING,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    if (repo.failSessionWrite !== undefined) {
      repo.failSessionWrite = true;
    }
    await expect(
      repo.consumeVerificationToken({
        tokenHash: hash,
        browserBindingHash: BINDING,
        now: NOW,
        signInSession: {
          kind: 'web-session',
          sessionId: 'sess_1',
          token: { raw: 'r', hash: 'wh_1', expiresAt: EXPIRES_AT },
          issuedAt: NOW,
        },
      }),
    ).rejects.toThrow();
    expect(state.verificationTokens.get(hash)?.signedInAt).toBeUndefined();
  });
}
