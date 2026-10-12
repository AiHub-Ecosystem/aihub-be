import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresLocalAuthRepository } from './postgres-local-auth.repository';

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
  username: 'person_01',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$hash',
  tokenId: 'evt_01J00000000000000000000000',
  tokenHash: 'a'.repeat(64),
  tokenExpiresAt: new Date('2026-09-20T00:00:00.000Z'),
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

function repositoryOver(script: ScriptedPrisma): PostgresLocalAuthRepository {
  return new PostgresLocalAuthRepository(script.client());
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

describe('PostgresLocalAuthRepository', () => {
  it('persists account, local identity, and token in one transaction', async () => {
    const script = new ScriptedPrisma();

    await repositoryOver(script).register(input);

    expect(script.statements.map(({ name }) => name)).toEqual([
      'userAccount.create',
      'authIdentity.create',
      'emailVerificationToken.create',
    ]);
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(JSON.stringify(script.statements[1]?.args)).toContain(
      input.passwordHash,
    );
    expect(JSON.stringify(script.statements[2]?.args)).toContain(
      input.tokenHash,
    );
  });

  it.each([
    ['a raw SQLSTATE', { code: '23505', detail: 'private database detail' }],
    ['a Prisma unique violation', { code: 'P2002', meta: { target: ['x'] } }],
  ])(
    'maps unique races (%s) to a generic identity conflict',
    async (_, failure) => {
      const script = new ScriptedPrisma();
      script.failure = failure;

      await expect(
        repositoryOver(script).register(input),
      ).rejects.toMatchObject({
        name: 'AuthIdentityConflictError',
      });
    },
  );

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
    script.inside = [[{ id: USER_ID, status: 'active' }], [openToken()]];

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

    expect(script.statements.map(({ name }) => name).slice(2)).toEqual([
      'emailVerificationToken.updateMany',
      'refreshToken.create',
    ]);
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(JSON.stringify(script.statements[3]?.args)).toContain(
      refreshToken.hash,
    );
    expect(allArgs(script)).not.toContain(refreshToken.raw);
  });

  it('stops without a session when another request already claimed the sign-in', async () => {
    const script = new ScriptedPrisma();
    script.inside = [
      [{ id: USER_ID, status: 'active' }],
      [openToken()],
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

  it('projects the password identity without returning profile fields', async () => {
    const script = new ScriptedPrisma();
    script.outside = [
      {
        canonicalEmail: input.email,
        passwordHash: input.passwordHash,
        userAccount: { id: USER_ID, status: 'active' },
      },
    ];

    await expect(
      repositoryOver(script).findLoginIdentityByEmail(input.email),
    ).resolves.toEqual({
      userId: USER_ID,
      email: input.email,
      status: 'active',
      passwordHash: input.passwordHash,
    });
  });

  it('reads durable account status for bearer authorization', async () => {
    const script = new ScriptedPrisma();
    script.outside = [{ status: 'disabled' }];

    await expect(
      repositoryOver(script).findUserAccountStatus(USER_ID),
    ).resolves.toBe('disabled');
  });

  it('reads the username only for the active bearer account', async () => {
    const script = new ScriptedPrisma();
    script.outside = [{ username: 'person_01' }];

    await expect(
      repositoryOver(script).findActiveUsername(USER_ID),
    ).resolves.toBe('person_01');
    expect(script.statements[0]?.args).toEqual([
      { where: { id: USER_ID, status: 'active' }, select: { username: true } },
    ]);

    const none = new ScriptedPrisma();
    await expect(
      repositoryOver(none).findActiveUsername(USER_ID),
    ).resolves.toBeUndefined();
  });

  it('persists only the refresh hash and rotates under a row lock', async () => {
    const script = new ScriptedPrisma();
    const repository = repositoryOver(script);

    script.inside = [[{ status: 'active' }], []];
    await repository.createRefreshSession({
      userId: USER_ID,
      token: refreshToken,
      issuedAt: input.now,
    });
    const created = script.statements.find(
      ({ name }) => name === 'refreshToken.create',
    );
    expect(JSON.stringify(created?.args)).toContain(refreshToken.hash);
    expect(allArgs(script)).not.toContain(refreshToken.raw);

    script.inside = [
      [
        {
          id: refreshToken.id,
          familyId: refreshToken.familyId,
          userAccountId: USER_ID,
          expiresAt: refreshToken.expiresAt,
          usedAt: null,
          revokedAt: null,
          status: 'active',
        },
      ],
    ];
    await expect(
      repository.rotateRefreshToken({
        tokenId: refreshToken.id,
        tokenHash: refreshToken.hash,
        successor: {
          ...refreshToken,
          id: 'rft_01J00000000000000000000001',
          raw: 'successor-token',
          hash: 'c'.repeat(64),
          expiresAt: new Date('2026-11-18T00:00:00.000Z'),
        },
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'rotated', userId: USER_ID });
    expect(script.statements.slice(-3).map(({ name }) => name)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      'refreshToken.updateMany',
      'refreshToken.create',
    ]);
  });

  it('revokes a whole family for a known stale token and ignores unknown logout tokens', async () => {
    const script = new ScriptedPrisma();
    script.inside = [[{ family_id: refreshToken.familyId }]];

    await repositoryOver(script).revokeRefreshFamilyByTokenHash({
      tokenHash: refreshToken.hash,
      now: input.now,
    });
    expect(script.statements).toHaveLength(2);
    expect(script.statements[1]).toMatchObject({
      name: 'refreshToken.updateMany',
      args: [
        {
          where: { familyId: refreshToken.familyId, revokedAt: null },
          data: { revokedAt: input.now },
        },
      ],
    });

    const unknown = new ScriptedPrisma();
    unknown.inside = [[]];
    await expect(
      repositoryOver(unknown).revokeRefreshFamilyByTokenHash({
        tokenHash: 'd'.repeat(64),
        now: input.now,
      }),
    ).resolves.toBeUndefined();
    expect(unknown.statements).toHaveLength(1);
  });

  it('maps malformed refresh projections to a safe invalid result', async () => {
    const script = new ScriptedPrisma();
    script.outside = [
      {
        id: refreshToken.id,
        familyId: refreshToken.familyId,
        userAccountId: USER_ID,
        expiresAt: 'not-a-date',
        usedAt: null,
        revokedAt: null,
      },
    ];

    await expect(
      repositoryOver(script).findRefreshTokenByHash(refreshToken.hash),
    ).resolves.toBeUndefined();
  });
});
