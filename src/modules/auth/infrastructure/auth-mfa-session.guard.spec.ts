import type { MfaSessionProof } from '@/modules/auth/application/auth-mfa-repository.port';
import type { Prisma } from '@prisma-client/client';
import { authorizeMfaSession } from './auth-mfa-session.guard';

const USER_ID = 'usr_01J00000000000000000000000';
const FACTOR_ID = 'mfa_01J00000000000000000000000';
const NOW = new Date(0);

function transaction(rows: {
  readonly status: string;
  readonly factorId?: string;
  readonly consumedRecoveryCodes?: number;
}) {
  const updateMany = jest.fn(async () => ({
    count: rows.consumedRecoveryCodes ?? 0,
  }));
  const client = {
    $queryRawUnsafe: jest.fn(async (text: string) => {
      if (text.includes('FROM user_accounts')) return [{ status: rows.status }];
      return rows.factorId === undefined ? [] : [{ factor_id: rows.factorId }];
    }),
    userMfaRecoveryCode: { updateMany },
  } as unknown as Prisma.TransactionClient;
  return { client, updateMany };
}

const totp = (factorId: string): MfaSessionProof => ({
  kind: 'totp',
  factorId,
});
const recovery: MfaSessionProof = {
  kind: 'recovery',
  codeHash: 'a'.repeat(64),
};

describe('authorizeMfaSession', () => {
  it('refuses an account that is no longer active, whatever the proof', async () => {
    const { client } = transaction({ status: 'disabled', factorId: FACTOR_ID });

    await expect(
      authorizeMfaSession(client, USER_ID, totp(FACTOR_ID), NOW),
    ).resolves.toBe(false);
  });

  it('admits an account without a factor only when no proof is claimed', async () => {
    const { client } = transaction({ status: 'active' });

    await expect(
      authorizeMfaSession(client, USER_ID, undefined, NOW),
    ).resolves.toBe(true);
    await expect(
      authorizeMfaSession(client, USER_ID, totp(FACTOR_ID), NOW),
    ).resolves.toBe(false);
  });

  it('refuses an account with an enabled factor and no proof', async () => {
    const { client } = transaction({ status: 'active', factorId: FACTOR_ID });

    await expect(
      authorizeMfaSession(client, USER_ID, undefined, NOW),
    ).resolves.toBe(false);
  });

  it('admits a TOTP proof only for the factor that is enabled now', async () => {
    const { client } = transaction({ status: 'active', factorId: FACTOR_ID });

    await expect(
      authorizeMfaSession(client, USER_ID, totp(FACTOR_ID), NOW),
    ).resolves.toBe(true);
    // A proof made against a factor since removed and re-enrolled.
    await expect(
      authorizeMfaSession(
        client,
        USER_ID,
        totp('mfa_01J00000000000000000000099'),
        NOW,
      ),
    ).resolves.toBe(false);
  });

  it('admits a Recovery Code proof only when this transaction consumes the code', async () => {
    const unused = transaction({
      status: 'active',
      factorId: FACTOR_ID,
      consumedRecoveryCodes: 1,
    });
    await expect(
      authorizeMfaSession(unused.client, USER_ID, recovery, NOW),
    ).resolves.toBe(true);
    expect(unused.updateMany).toHaveBeenCalledWith({
      where: {
        userAccountId: USER_ID,
        codeHash: 'a'.repeat(64),
        consumedAt: null,
      },
      data: { consumedAt: NOW },
    });

    const spent = transaction({ status: 'active', factorId: FACTOR_ID });
    await expect(
      authorizeMfaSession(spent.client, USER_ID, recovery, NOW),
    ).resolves.toBe(false);
  });
});
