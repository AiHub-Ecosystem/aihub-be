import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresPasswordResetTokenRepository } from './postgres-password-reset-token.repository';

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
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$hash',
  tokenId: 'prt_01J00000000000000000000000',
  tokenHash: 'a'.repeat(64),
  tokenExpiresAt: new Date('2026-09-20T00:00:00.000Z'),
  now: new Date('2026-09-19T00:00:00.000Z'),
};

const USER_ID = 'usr_01J00000000000000000000000';

function repositoryOver(
  script: ScriptedPrisma,
): PostgresPasswordResetTokenRepository {
  return new PostgresPasswordResetTokenRepository(script.client());
}

function allArgs(script: ScriptedPrisma): string {
  return JSON.stringify(script.statements.map(({ args }) => args));
}

/** What the reset token's locking read returns, aliased to model field names. */
function resetToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prt_01J00000000000000000000000',
    userAccountId: USER_ID,
    expiresAt: new Date('2026-09-20T01:00:00.000Z'),
    consumedAt: null,
    status: 'active',
    ...overrides,
  };
}

describe('PostgresPasswordResetTokenRepository', () => {
  it('issues a reset token only for an active password identity and supersedes open tokens', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [{ id: USER_ID, canonical_email: input.email, status: 'active' }],
    ];

    await expect(
      repositoryOver(script).issuePasswordResetToken({
        email: input.email,
        tokenId: 'prt_01J00000000000000000000000',
        tokenHash: input.tokenHash,
        tokenExpiresAt: input.tokenExpiresAt,
        now: input.now,
      }),
    ).resolves.toEqual({ email: input.email });

    expect(script.statements.map(({ name }) => name).slice(1)).toEqual([
      'passwordResetToken.updateMany',
      'passwordResetToken.create',
    ]);
    expect(JSON.stringify(script.statements[2]?.args)).toContain(
      input.tokenHash,
    );
  });

  it('atomically changes the password, consumes reset tokens, and revokes every refresh session and web session', async () => {
    const script = new ScriptedPrisma();
    script.inside = [[resetToken()]];

    await expect(
      repositoryOver(script).consumePasswordReset({
        tokenHash: input.tokenHash,
        passwordHash: input.passwordHash,
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'reset' });

    expect(script.statements.slice(1).map(({ name }) => name)).toEqual([
      'authIdentity.updateMany',
      'passwordResetToken.updateMany',
      'passwordResetToken.updateMany',
      'refreshToken.updateMany',
      'webSession.updateMany',
    ]);
    // Both revocations ride the ONE transaction that changed the password, so a
    // failure anywhere rolls all of it back: no half-revoked account is
    // observable between them.
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(script.statements.slice(-2).map(({ args }) => args[0])).toEqual([
      {
        where: { userAccountId: USER_ID, revokedAt: null },
        data: { revokedAt: input.now },
      },
      {
        where: { userAccountId: USER_ID, revokedAt: null },
        data: { revokedAt: input.now },
      },
    ]);
    expect(allArgs(script)).not.toContain('reset-token');
  });

  it('revokes no web session at all when the reset token is not consumable', async () => {
    const script = new ScriptedPrisma();
    script.inside = [[]];

    await expect(
      repositoryOver(script).consumePasswordReset({
        tokenHash: input.tokenHash,
        passwordHash: input.passwordHash,
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'invalid', reason: 'missing' });

    expect(script.statements).toHaveLength(1);
  });

  it('rolls back rather than continue when the reset token was consumed concurrently', async () => {
    const script = new ScriptedPrisma();
    script.inside = [[resetToken()], { count: 1 }, { count: 0 }];

    await expect(
      repositoryOver(script).consumePasswordReset({
        tokenHash: input.tokenHash,
        passwordHash: input.passwordHash,
        now: input.now,
      }),
    ).rejects.toThrow('password reset token was concurrently consumed');
    expect(script.statements.map(({ name }) => name)).not.toContain(
      'webSession.updateMany',
    );
  });

  it('returns one invalid result for missing, expired, consumed, and inactive reset state', async () => {
    const cases = [
      { rows: [], reason: 'missing' as const },
      {
        rows: [resetToken({ expiresAt: new Date('2026-09-19T00:00:00.000Z') })],
        reason: 'expired' as const,
      },
      {
        rows: [resetToken({ consumedAt: input.now })],
        reason: 'consumed' as const,
      },
      {
        rows: [resetToken({ status: 'disabled' })],
        reason: 'inactive' as const,
      },
    ];

    for (const current of cases) {
      const script = new ScriptedPrisma();
      script.inside = [current.rows];
      await expect(
        repositoryOver(script).consumePasswordReset({
          tokenHash: input.tokenHash,
          passwordHash: input.passwordHash,
          now: input.now,
        }),
      ).resolves.toEqual({ kind: 'invalid', reason: current.reason });
    }
  });

  it('checks reset-token state without performing password work', async () => {
    const script = new ScriptedPrisma();
    script.outside = [
      {
        id: 'prt_01J00000000000000000000000',
        userAccountId: USER_ID,
        expiresAt: new Date('2026-09-20T01:00:00.000Z'),
        consumedAt: null,
        userAccount: { status: 'active' },
      },
    ];

    await expect(
      repositoryOver(script).checkPasswordResetToken({
        tokenHash: input.tokenHash,
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'valid' });
    expect(script.statements).toHaveLength(1);
    expect(script.statements[0]).toMatchObject({
      name: 'passwordResetToken.findUnique',
      args: [{ where: { tokenHash: input.tokenHash } }],
    });
  });
});
