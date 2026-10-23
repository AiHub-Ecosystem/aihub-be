import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresVerificationTokenRepository } from './postgres-verification-token.repository';

/**
 * `ScriptedPrisma` records every statement with the transaction that issued it:
 * `0` for a statement on the client itself, then one number per transaction.
 * That is what makes "one durable step" checkable here — a mutation claimed to
 * ride one transaction is only in it while its statement carries the same
 * number. The database lane proves the locks and the engine's rollback; this
 * proves which statements make up each step.
 */

const input = {
  email: 'person@example.com',
  tokenId: 'evt_01J00000000000000000000000',
  tokenHash: 'a'.repeat(64),
  tokenExpiresAt: new Date('2026-09-20T00:00:00.000Z'),
  requiresPassword: false,
  now: new Date('2026-09-19T00:00:00.000Z'),
};

const refreshToken = {
  id: 'rft_01J00000000000000000000000',
  familyId: 'rfs_01J00000000000000000000000',
  raw: 'refresh-token',
  hash: 'b'.repeat(64),
  expiresAt: new Date('2026-10-19T00:00:00.000Z'),
};

const USER_ID = 'usr_01J00000000000000000000000';

function repositoryOver(
  script: ScriptedPrisma,
): PostgresVerificationTokenRepository {
  return new PostgresVerificationTokenRepository(script.client());
}

function allArgs(script: ScriptedPrisma): string {
  return JSON.stringify(script.statements.map(({ args }) => args));
}

/** What the verification token's locking read returns. */
function openToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_01J00000000000000000000000',
    expires_at: input.tokenExpiresAt,
    consumed_at: input.now,
    consumed_reason: 'verified',
    browser_binding_hash: 'binding-hash',
    signed_in_at: null,
    ...overrides,
  };
}

/**
 * What the session admission reads after the token is locked: the account's
 * status, then its enabled second factor, if any.
 */
function admitted(options: { readonly factorId?: string } = {}): unknown[] {
  return [
    [{ status: 'active' }],
    options.factorId === undefined ? [] : [{ factor_id: options.factorId }],
  ];
}

describe('PostgresVerificationTokenRepository', () => {
  it('invalidates open tokens before inserting a resend token for pending accounts', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [
        {
          id: USER_ID,
          canonical_email: input.email,
          status: 'pending_verification',
        },
      ],
    ];

    const result = await repositoryOver(script).rotateVerificationToken({
      email: input.email,
      tokenId: input.tokenId,
      tokenHash: input.tokenHash,
      tokenExpiresAt: input.tokenExpiresAt,
      requiresPassword: false,
      now: input.now,
    });

    expect(result).toEqual({ email: input.email });
    expect(script.statements.map(({ name }) => name).slice(1)).toEqual([
      'emailVerificationToken.updateMany',
      'emailVerificationToken.create',
    ]);
    expect(JSON.stringify(script.statements[2]?.args)).toContain(
      input.tokenHash,
    );
  });

  it('leaves no session behind when a request only verifies', async () => {
    const script = new ScriptedPrisma();
    script.inside = [[{ id: USER_ID, status: 'active' }], [openToken()]];

    await expect(
      repositoryOver(script).consumeVerificationToken({
        tokenHash: input.tokenHash,
        signInSession: {
          kind: 'refresh',
          token: refreshToken,
          issuedAt: input.now,
        },
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'verified' });

    expect(script.statements).toHaveLength(2);
    expect(allArgs(script)).not.toContain(refreshToken.hash);
  });

  it('commits the Verification Sign-in claim and its Refresh Session in one transaction', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [{ id: USER_ID, status: 'active' }],
      [openToken()],
      ...admitted(),
    ];

    await expect(
      repositoryOver(script).consumeVerificationToken({
        tokenHash: input.tokenHash,
        browserBindingHash: 'binding-hash',
        signInSession: {
          kind: 'refresh',
          token: refreshToken,
          issuedAt: input.now,
        },
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'signed_in', userId: USER_ID });

    expect(
      script.statements
        .map(({ name }) => name)
        .filter((name) => /^\w+\.\w+$/.test(name)),
    ).toEqual(['emailVerificationToken.updateMany', 'refreshToken.create']);
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(
      JSON.stringify(
        script.statements.find(({ name }) => name === 'refreshToken.create')
          ?.args,
      ),
    ).toContain(refreshToken.hash);
    expect(allArgs(script)).not.toContain(refreshToken.raw);
  });

  it('verifies without a session, and spends no claim, for an account with a second factor', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [{ id: USER_ID, status: 'active' }],
      [openToken()],
      ...admitted({ factorId: 'mfa_01J00000000000000000000000' }),
    ];

    await expect(
      repositoryOver(script).consumeVerificationToken({
        tokenHash: input.tokenHash,
        browserBindingHash: 'binding-hash',
        signInSession: {
          kind: 'refresh',
          token: refreshToken,
          issuedAt: input.now,
        },
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'verified' });

    const names = script.statements.map(({ name }) => name);
    expect(names).not.toContain('emailVerificationToken.updateMany');
    expect(names).not.toContain('refreshToken.create');
  });

  it('stops without a session when another request already claimed the sign-in', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [{ id: USER_ID, status: 'active' }],
      [openToken()],
      ...admitted(),
      { count: 0 },
    ];

    await expect(
      repositoryOver(script).consumeVerificationToken({
        tokenHash: input.tokenHash,
        browserBindingHash: 'binding-hash',
        signInSession: {
          kind: 'refresh',
          token: refreshToken,
          issuedAt: input.now,
        },
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'verified' });

    expect(script.statements.map(({ name }) => name)).not.toContain(
      'refreshToken.create',
    );
  });
});
