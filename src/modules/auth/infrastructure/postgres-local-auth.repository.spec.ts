import type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './postgres-auth.client';
import { PostgresLocalAuthRepository } from './postgres-local-auth.repository';

class FakeClient implements PostgresAuthClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  responses: readonly Record<string, unknown>[][] = [];
  failure: unknown;

  async query(): Promise<readonly Record<string, unknown>[]> {
    return [];
  }

  async transaction<T>(
    callback: (client: PostgresAuthQueryClient) => Promise<T>,
  ): Promise<T> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    let index = 0;
    return callback({
      query: async (text, values) => {
        this.queries.push({ text, values });
        return this.responses[index++] ?? [];
      },
    });
  }

  async close(): Promise<void> {}
}

const input = {
  email: 'person@example.com',
  username: 'person_01',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$hash',
  tokenId: 'evt_01J00000000000000000000000',
  tokenHash: 'a'.repeat(64),
  tokenExpiresAt: new Date('2026-09-20T00:00:00.000Z'),
  now: new Date('2026-09-19T00:00:00.000Z'),
};

describe('PostgresLocalAuthRepository', () => {
  it('persists account, local identity, and token in one transaction', async () => {
    const client = new FakeClient();
    const repository = new PostgresLocalAuthRepository(client);

    await repository.register(input);

    expect(client.queries).toHaveLength(3);
    expect(client.queries[0]?.text).toContain('INSERT INTO user_accounts');
    expect(client.queries[1]?.text).toContain('INSERT INTO auth_identities');
    expect(client.queries[2]?.text).toContain(
      'INSERT INTO email_verification_tokens',
    );
    expect(client.queries[1]?.values).toContain(input.passwordHash);
    expect(client.queries[2]?.values).toContain(input.tokenHash);
  });

  it('maps unique races to a generic identity conflict', async () => {
    const client = new FakeClient();
    client.failure = { code: '23505', detail: 'private database detail' };

    await expect(
      new PostgresLocalAuthRepository(client).register(input),
    ).rejects.toMatchObject({ name: 'AuthIdentityConflictError' });
  });

  it('invalidates open tokens before inserting a resend token for pending accounts', async () => {
    const client = new FakeClient();
    client.responses = [
      [
        {
          id: 'usr_01J00000000000000000000000',
          canonical_email: input.email,
          status: 'pending_verification',
        },
      ],
    ];
    const result = await new PostgresLocalAuthRepository(
      client,
    ).rotateVerificationToken({
      email: input.email,
      tokenId: input.tokenId,
      tokenHash: input.tokenHash,
      tokenExpiresAt: input.tokenExpiresAt,
      now: input.now,
    });

    expect(result).toEqual({ email: input.email });
    expect(client.queries[1]?.text).toContain('SET consumed_at');
    expect(client.queries[2]?.text).toContain(
      'INSERT INTO email_verification_tokens',
    );
  });

  it('atomically consumes a valid token and activates only a pending account', async () => {
    const client = new FakeClient();
    client.responses = [
      [{ user_account_id: 'usr_01J00000000000000000000000' }],
      [{ id: 'usr_01J00000000000000000000000' }],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).consumeVerificationToken({
        tokenHash: input.tokenHash,
        now: input.now,
      }),
    ).resolves.toBe(true);
    expect(client.queries[0]?.text).toContain('SET consumed_at');
    expect(client.queries[1]?.text).toContain("SET status = 'active'");
  });
});
