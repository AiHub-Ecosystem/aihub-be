import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresEmailCredentialRepository } from './postgres-email-credential.repository';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const TOKEN_HASH = 'a'.repeat(64);

/** The row the credential table answers with, or none for an absent one. */
function check(
  row: Record<string, unknown> | null,
  kind:
    | 'verification_email'
    | 'password_reset_email'
    | 'organization_invite_email' = 'verification_email',
) {
  const script = new ScriptedPrisma();
  script.outside = [row];
  const result = new PostgresEmailCredentialRepository(script.client()).check({
    kind,
    tokenHash: TOKEN_HASH,
    now: NOW,
  });
  return { result, script };
}

describe('PostgresEmailCredentialRepository', () => {
  it('reads an open, unexpired credential as actionable', async () => {
    await expect(
      check({ expiresAt: new Date(NOW.getTime() + 60_000), consumedAt: null })
        .result,
    ).resolves.toBe('actionable');
  });

  it('reads a closed credential as closed whatever consumed it', async () => {
    await expect(
      check({
        expiresAt: new Date(NOW.getTime() + 60_000),
        consumedAt: new Date(NOW.getTime() - 1),
      }).result,
    ).resolves.toBe('closed');
  });

  it('reads a credential that expired at this instant as expired', async () => {
    await expect(
      check({ expiresAt: NOW, consumedAt: null }).result,
    ).resolves.toBe('expired');
  });

  it('reads an absent credential as missing', async () => {
    await expect(check(null).result).resolves.toBe('missing');
  });

  it.each([
    ['verification_email', 'emailVerificationToken.findUnique'],
    ['password_reset_email', 'passwordResetToken.findUnique'],
    ['organization_invite_email', 'organizationInvitation.findUnique'],
  ] as const)(
    'reads a %s from its own table by token hash',
    async (kind, name) => {
      const { result, script } = check(null, kind);
      await result;

      expect(script.statements).toEqual([
        {
          name,
          args: [
            {
              where: { tokenHash: TOKEN_HASH },
              select: { expiresAt: true, consumedAt: true },
            },
          ],
          transaction: 0,
        },
      ]);
    },
  );

  it.each([
    ['no expiry column', {}],
    ['a null expiry column', { expiresAt: null, consumedAt: null }],
    ['an expiry that is not a date', { expiresAt: 'tomorrow' }],
    ['an invalid expiry', { expiresAt: new Date('never') }],
    ['a consumed column that is not a date', { consumedAt: 'earlier' }],
    [
      'a consumed column that is an invalid date',
      { expiresAt: NOW, consumedAt: new Date(NaN) },
    ],
  ])(
    'refuses a row with %s rather than deciding on a cast',
    async (_label, row) => {
      await expect(check(row).result).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    },
  );
});
