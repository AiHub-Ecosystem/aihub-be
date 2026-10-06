import { PostgresEmailCredentialRepository } from './postgres-email-credential.repository';
import type { EmailDeliveryQueryClient } from './postgres-email-delivery-request.repository';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const TOKEN_HASH = 'a'.repeat(64);

function clientReturning(rows: readonly Record<string, unknown>[]) {
  const client: EmailDeliveryQueryClient = {
    query: async (): Promise<readonly Record<string, unknown>[]> => rows,
  };
  return client;
}

function check(
  rows: readonly Record<string, unknown>[],
  client: EmailDeliveryQueryClient = clientReturning(rows),
): Promise<string> {
  return new PostgresEmailCredentialRepository(client).check({
    kind: 'verification_email',
    tokenHash: TOKEN_HASH,
    now: NOW,
  });
}

describe('PostgresEmailCredentialRepository', () => {
  it('reads an open, unexpired credential as actionable', async () => {
    await expect(
      check([
        {
          expires_at: new Date(NOW.getTime() + 60_000),
          consumed_at: null,
        },
      ]),
    ).resolves.toBe('actionable');
  });

  it('reads a closed credential as closed whatever consumed it', async () => {
    await expect(
      check([
        {
          expires_at: new Date(NOW.getTime() + 60_000),
          consumed_at: new Date(NOW.getTime() - 1),
        },
      ]),
    ).resolves.toBe('closed');
  });

  it('reads a credential that expired at this instant as expired', async () => {
    await expect(check([{ expires_at: NOW, consumed_at: null }])).resolves.toBe(
      'expired',
    );
  });

  it('reads an absent credential as missing', async () => {
    await expect(check([])).resolves.toBe('missing');
  });

  it.each([
    ['no expiry column', {}],
    ['a null expiry column', { expires_at: null, consumed_at: null }],
    ['an expiry that is not a date', { expires_at: 'tomorrow' }],
    ['an invalid expiry', { expires_at: new Date('never') }],
    ['a consumed column that is not a date', { consumed_at: 'earlier' }],
    [
      'a consumed column that is an invalid date',
      { consumed_at: new Date(NaN) },
    ],
  ])(
    'refuses a row with %s rather than deciding on a cast',
    async (_l, row) => {
      await expect(check([row])).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    },
  );
});
