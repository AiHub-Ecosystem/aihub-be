import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresRefreshSessionRepository } from './postgres-refresh-session.repository';

/**
 * `ScriptedPrisma` records every statement with the transaction that issued it:
 * `0` for a statement on the client itself, then one number per transaction.
 * That is what makes "one durable step" checkable here — a mutation claimed to
 * ride one transaction is only in it while its statement carries the same
 * number. The database lane proves the locks and the engine's rollback; this
 * proves which statements make up each step.
 */

const input = {
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
): PostgresRefreshSessionRepository {
  return new PostgresRefreshSessionRepository(script.client());
}

function allArgs(script: ScriptedPrisma): string {
  return JSON.stringify(script.statements.map(({ args }) => args));
}

describe('PostgresRefreshSessionRepository', () => {
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

  it('commits the rotation and its successor in one transaction', async () => {
    const script = new ScriptedPrisma();
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
      repositoryOver(script).rotateRefreshToken({
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

    // The consumption and the successor ride ONE transaction, so a failure
    // storing the successor leaves the presented token unspent and exchangeable
    // again rather than stranding the caller with neither.
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(allArgs(script)).not.toContain('successor-token');
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
