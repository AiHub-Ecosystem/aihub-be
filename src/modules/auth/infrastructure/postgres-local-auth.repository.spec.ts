import type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './postgres-auth.client';
import { PostgresLocalAuthRepository } from './postgres-local-auth.repository';

class FakeClient implements PostgresAuthClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  responses: readonly Record<string, unknown>[][] = [];
  queryResponses: Record<string, unknown>[][] = [];
  failure: unknown;

  async query(text: string, values: readonly unknown[]) {
    this.queries.push({ text, values });
    return this.queryResponses.shift() ?? [];
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

const refreshToken = {
  id: 'rft_01J00000000000000000000000',
  familyId: 'rfs_01J00000000000000000000000',
  raw: 'refresh-token',
  hash: 'b'.repeat(64),
  expiresAt: new Date('2026-10-19T00:00:00.000Z'),
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

  it('issues a reset token only for an active password identity and supersedes open tokens', async () => {
    const client = new FakeClient();
    client.responses = [
      [
        {
          id: 'usr_01J00000000000000000000000',
          canonical_email: input.email,
          status: 'active',
        },
      ],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).issuePasswordResetToken({
        email: input.email,
        tokenId: 'prt_01J00000000000000000000000',
        tokenHash: input.tokenHash,
        tokenExpiresAt: input.tokenExpiresAt,
        now: input.now,
      }),
    ).resolves.toEqual({ email: input.email });
    expect(client.queries[0]?.text).toContain('FOR UPDATE');
    expect(client.queries[1]?.text).toContain('password_reset_tokens');
    expect(client.queries[1]?.text).toContain('SET consumed_at');
    expect(client.queries[2]?.text).toContain(
      'INSERT INTO password_reset_tokens',
    );
    expect(JSON.stringify(client.queries)).not.toContain('token_value');
  });

  it('atomically changes the password, consumes reset tokens, and revokes every refresh session', async () => {
    const client = new FakeClient();
    client.responses = [
      [
        {
          id: 'prt_01J00000000000000000000000',
          user_account_id: 'usr_01J00000000000000000000000',
          expires_at: new Date('2026-09-20T01:00:00.000Z'),
          consumed_at: null,
          status: 'active',
        },
      ],
      [{ id: 'auth_01J00000000000000000000000' }],
      [{ id: 'prt_01J00000000000000000000000' }],
      [],
      [],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).consumePasswordReset({
        tokenHash: input.tokenHash,
        passwordHash: input.passwordHash,
        now: input.now,
      }),
    ).resolves.toEqual({
      kind: 'reset',
    });
    const sql = client.queries.map((query) => query.text).join('\n');
    expect(sql).toContain('FROM password_reset_tokens token');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('UPDATE auth_identities');
    expect(sql).toContain('SET consumed_at');
    expect(sql).toContain('UPDATE refresh_tokens');
    expect(sql).toContain('revoked_at = $2');
    expect(JSON.stringify(client.queries)).not.toContain('reset-token');
  });

  it('returns one invalid result for missing, expired, consumed, and inactive reset state', async () => {
    const cases = [
      { rows: [], reason: 'missing' as const },
      {
        rows: [
          {
            id: 'prt_01J00000000000000000000000',
            user_account_id: 'usr_01J00000000000000000000000',
            expires_at: new Date('2026-09-19T00:00:00.000Z'),
            consumed_at: null,
            status: 'active',
          },
        ],
        reason: 'expired' as const,
      },
      {
        rows: [
          {
            id: 'prt_01J00000000000000000000000',
            user_account_id: 'usr_01J00000000000000000000000',
            expires_at: new Date('2026-09-20T01:00:00.000Z'),
            consumed_at: input.now,
            status: 'active',
          },
        ],
        reason: 'consumed' as const,
      },
      {
        rows: [
          {
            id: 'prt_01J00000000000000000000000',
            user_account_id: 'usr_01J00000000000000000000000',
            expires_at: new Date('2026-09-20T01:00:00.000Z'),
            consumed_at: null,
            status: 'disabled',
          },
        ],
        reason: 'inactive' as const,
      },
    ];

    for (const current of cases) {
      const client = new FakeClient();
      client.responses = [current.rows];
      await expect(
        new PostgresLocalAuthRepository(client).consumePasswordReset({
          tokenHash: input.tokenHash,
          passwordHash: input.passwordHash,
          now: input.now,
        }),
      ).resolves.toEqual({ kind: 'invalid', reason: current.reason });
    }
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

  it('checks reset-token state without performing password work', async () => {
    const client = new FakeClient();
    client.queryResponses = [
      [
        {
          id: 'prt_01J00000000000000000000000',
          user_account_id: 'usr_01J00000000000000000000000',
          expires_at: new Date('2026-09-20T01:00:00.000Z'),
          consumed_at: null,
          status: 'active',
        },
      ],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).checkPasswordResetToken({
        tokenHash: input.tokenHash,
        now: input.now,
      }),
    ).resolves.toEqual({ kind: 'valid' });
    expect(client.queries[0]?.text).not.toContain('FOR UPDATE');
  });

  it('projects the password identity without returning profile fields', async () => {
    const client = new FakeClient();
    client.queryResponses = [
      [
        {
          id: 'usr_01J00000000000000000000000',
          status: 'active',
          password_hash: input.passwordHash,
        },
      ],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).findLoginIdentityByEmail(
        input.email,
      ),
    ).resolves.toEqual({
      userId: 'usr_01J00000000000000000000000',
      status: 'active',
      passwordHash: input.passwordHash,
    });
    expect(client.queries[0]?.text).toContain('JOIN auth_identities');
    expect(client.queries[0]?.text).toContain("ai.provider = 'password'");
    expect(JSON.stringify(client.queries[0])).not.toContain('username');
  });

  it('reads durable account status for bearer authorization', async () => {
    const client = new FakeClient();
    client.queryResponses = [[{ status: 'disabled' }]];

    await expect(
      new PostgresLocalAuthRepository(client).findUserAccountStatus(
        'usr_01J00000000000000000000000',
      ),
    ).resolves.toBe('disabled');
  });

  it('persists only the refresh hash and rotates under a row lock', async () => {
    const client = new FakeClient();
    const repository = new PostgresLocalAuthRepository(client);
    await repository.createRefreshSession({
      userId: 'usr_01J00000000000000000000000',
      token: refreshToken,
      issuedAt: input.now,
    });
    expect(client.queries[0]?.text).toContain('INSERT INTO refresh_tokens');
    expect(client.queries[0]?.values).toContain(refreshToken.hash);
    expect(JSON.stringify(client.queries[0])).not.toContain(refreshToken.raw);

    client.responses = [
      [
        {
          token_id: refreshToken.id,
          family_id: refreshToken.familyId,
          user_account_id: 'usr_01J00000000000000000000000',
          expires_at: refreshToken.expiresAt,
          used_at: null,
          revoked_at: null,
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
    ).resolves.toEqual({
      kind: 'rotated',
      userId: 'usr_01J00000000000000000000000',
    });
    const rotationSql = client.queries.map((query) => query.text).join('\n');
    expect(rotationSql).toContain('FOR UPDATE');
    expect(rotationSql).toContain('SET used_at');
    expect(rotationSql).toContain('INSERT INTO refresh_tokens');
  });

  it('revokes a whole family for a known stale token and ignores unknown logout tokens', async () => {
    const client = new FakeClient();
    client.responses = [[{ family_id: refreshToken.familyId }]];
    const repository = new PostgresLocalAuthRepository(client);

    await repository.revokeRefreshFamilyByTokenHash({
      tokenHash: refreshToken.hash,
      now: input.now,
    });
    expect(client.queries.map((query) => query.text).join('\n')).toContain(
      'WHERE family_id = $1 AND revoked_at IS NULL',
    );

    const unknownClient = new FakeClient();
    unknownClient.responses = [[]];
    await expect(
      new PostgresLocalAuthRepository(
        unknownClient,
      ).revokeRefreshFamilyByTokenHash({
        tokenHash: 'd'.repeat(64),
        now: input.now,
      }),
    ).resolves.toBeUndefined();
    expect(unknownClient.queries).toHaveLength(1);
  });

  it('maps malformed refresh projections to a safe invalid result', async () => {
    const client = new FakeClient();
    client.queryResponses = [
      [
        {
          token_id: refreshToken.id,
          family_id: refreshToken.familyId,
          user_account_id: 'usr_01J00000000000000000000000',
          expires_at: 'not-a-date',
          used_at: null,
          revoked_at: null,
        },
      ],
    ];

    await expect(
      new PostgresLocalAuthRepository(client).findRefreshTokenByHash(
        refreshToken.hash,
      ),
    ).resolves.toBeUndefined();
  });
});
