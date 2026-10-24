import type { EmailDeliveryRequestWriterPort } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { LOCK_PASSWORD_IDENTITY_SQL } from '@/modules/auth/local-credentials/infrastructure/local-auth-statements';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresUserAccountRepository } from './postgres-user-account.repository';

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
  passwordHash: ARGON2ID_DUMMY_HASH,
  tokenId: 'evt_01J00000000000000000000000',
  tokenHash: 'a'.repeat(64),
  tokenExpiresAt: new Date('2026-09-20T00:00:00.000Z'),
  requiresPassword: false,
  now: new Date('2026-09-19T00:00:00.000Z'),
};

const USER_ID = 'usr_01J00000000000000000000000';

function repositoryOver(script: ScriptedPrisma): PostgresUserAccountRepository {
  return new PostgresUserAccountRepository(script.client());
}

/** A writer whose recipient reservation answers `reserve` and records inserts. */
function scriptedEmailWriter(
  reserve: boolean,
): EmailDeliveryRequestWriterPort & {
  readonly inserted: unknown[];
} {
  const inserted: unknown[] = [];
  return {
    inserted,
    reserveAuthenticationEmailRecipient: async () => reserve,
    insert: async (_transaction, request) => {
      inserted.push(request);
    },
    queuedPayloadCiphertexts: async () => [],
    cancelQueued: async () => undefined,
  };
}

const emailDelivery = {
  id: 'edr_01J00000000000000000000000',
  kind: 'verification_email',
  payloadCiphertext: 'sealed',
  createdAt: input.now,
} as const;

describe('PostgresUserAccountRepository', () => {
  it('persists account, local identity, and token in one transaction', async () => {
    const script = new ScriptedPrisma();

    await repositoryOver(script).register(input);

    expect(script.statements.map(({ name }) => name)).toEqual([
      LOCK_PASSWORD_IDENTITY_SQL,
      'userAccount.create',
      'authIdentity.create',
      'emailVerificationToken.create',
    ]);
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(JSON.stringify(script.statements[2]?.args)).toContain(
      input.passwordHash,
    );
    expect(JSON.stringify(script.statements[3]?.args)).toContain(
      input.tokenHash,
    );
  });

  it('replaces the credential and username of a pending account for the same email in one transaction', async () => {
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

    await repositoryOver(script).register(input);

    expect(script.statements.map(({ name }) => name)).toEqual([
      LOCK_PASSWORD_IDENTITY_SQL,
      'userAccount.update',
      'authIdentity.updateMany',
      'emailVerificationToken.updateMany',
      'emailVerificationToken.create',
    ]);
    expect(script.opened).toBe(1);
    expect(
      script.statements.every(({ transaction }) => transaction === 1),
    ).toBe(true);
    expect(JSON.stringify(script.statements[1]?.args)).toContain(
      input.username,
    );
    expect(JSON.stringify(script.statements[2]?.args)).toContain(
      input.passwordHash,
    );
    expect(JSON.stringify(script.statements[3]?.args)).toContain('superseded');
    expect(JSON.stringify(script.statements[4]?.args)).toContain(
      input.tokenHash,
    );
  });

  it('leaves a pending registration untouched when the recipient reservation is refused', async () => {
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
    const emailRequests = scriptedEmailWriter(false);

    const result = await new PostgresUserAccountRepository(
      script.client(),
      emailRequests,
    ).register({ ...input, emailDelivery });

    // The delivered verification link stays the account's only usable one:
    // no replacement, no token, no outbox row, and the pending-expiry
    // timestamp is not renewed (#932).
    expect(result).toBe('suppressed');
    expect(script.statements.map(({ name }) => name)).toEqual([
      LOCK_PASSWORD_IDENTITY_SQL,
    ]);
    expect(emailRequests.inserted).toEqual([]);
  });

  it('replaces and queues when the reservation allows the replacement', async () => {
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
    const emailRequests = scriptedEmailWriter(true);

    const result = await new PostgresUserAccountRepository(
      script.client(),
      emailRequests,
    ).register({ ...input, emailDelivery });

    expect(result).toBe('queued');
    expect(script.statements.map(({ name }) => name)).toEqual([
      LOCK_PASSWORD_IDENTITY_SQL,
      'userAccount.update',
      'authIdentity.updateMany',
      'emailVerificationToken.updateMany',
      'emailVerificationToken.create',
    ]);
    expect(emailRequests.inserted).toEqual([emailDelivery]);
  });

  it('still creates a new suppressed account when the reservation is refused', async () => {
    const script = new ScriptedPrisma();
    const emailRequests = scriptedEmailWriter(false);

    const result = await new PostgresUserAccountRepository(
      script.client(),
      emailRequests,
    ).register({ ...input, emailDelivery });

    // ADR-0096's baseline: an email with no account yet still gets its
    // pending account and token, just no outbox row.
    expect(result).toBe('suppressed');
    expect(script.statements.map(({ name }) => name)).toEqual([
      LOCK_PASSWORD_IDENTITY_SQL,
      'userAccount.create',
      'authIdentity.create',
      'emailVerificationToken.create',
    ]);
    expect(emailRequests.inserted).toEqual([]);
  });

  it.each(['active', 'disabled'])(
    'refuses an email whose account is %s and writes nothing',
    async (status) => {
      const script = new ScriptedPrisma();
      script.inside = [[{ id: USER_ID, canonical_email: input.email, status }]];

      await expect(
        repositoryOver(script).register(input),
      ).rejects.toMatchObject({ name: 'AuthIdentityConflictError' });

      expect(script.statements.map(({ name }) => name)).toEqual([
        LOCK_PASSWORD_IDENTITY_SQL,
      ]);
    },
  );

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
});
