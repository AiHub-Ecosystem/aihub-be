import { AppError } from '../../../common/errors/app-error';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type { PostgresIdentityClient } from './postgres-api-key.repository';
import type { PostgresIdentityTransactionalClient } from './postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from './postgres-organization-membership.repository';

const membershipRow = {
  organization_id: 'org_acme',
  user_account_id: 'usr_01J00000000000000000000000',
  organization_status: 'active',
  role: 'owner',
  membership_status: 'active',
};

const rosterRows = [
  {
    organization_id: 'org_acme',
    organization_name: 'Acme',
    organization_status: 'active',
    caller_role: 'owner',
    member_username: 'alice',
    member_role: 'owner',
  },
  {
    organization_id: 'org_acme',
    organization_name: 'Acme',
    organization_status: 'active',
    caller_role: 'owner',
    member_username: 'bob',
    member_role: 'member',
  },
  {
    organization_id: 'org_suspended',
    organization_name: 'Suspended',
    organization_status: 'suspended',
    caller_role: 'member',
    member_username: 'alice',
    member_role: 'member',
  },
];

const context = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-21T00:00:00.000Z'),
  deadlineMs: 5_000,
  userId: membershipRow.user_account_id,
  scopes: [],
});

const mutationContext = createRequestContext({
  requestId: 'req_01J00000000000000000000000',
  receivedAt: new Date('2026-09-21T00:00:00.000Z'),
  deadlineMs: 5_000,
  userId: membershipRow.user_account_id,
  organizationId: 'org_acme',
  scopes: [],
});

class FakePostgres implements PostgresIdentityClient {
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  result: readonly unknown[] = [membershipRow];
  shouldFail = false;
  transactionRows: readonly (readonly unknown[])[] = [];
  transactionQueries: Array<{ text: string; values: readonly unknown[] }> = [];

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    if (this.shouldFail) {
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  transaction<T>(
    callback: Parameters<PostgresIdentityTransactionalClient['transaction']>[0],
  ): Promise<T> {
    let index = 0;
    return callback({
      query: async (text, values) => {
        this.transactionQueries.push({ text, values });
        if (this.shouldFail) {
          throw new Error('database unavailable');
        }
        const rows = this.transactionRows[index] ?? [];
        index += 1;
        return rows;
      },
    }) as Promise<T>;
  }
}

const organizationRow = { id: 'org_acme', status: 'active' };
const callerOwnerRow = {
  organization_id: 'org_acme',
  user_account_id: membershipRow.user_account_id,
  username: 'alice',
  role: 'owner',
  membership_status: 'active',
};
const targetMemberRow = {
  organization_id: 'org_acme',
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'member',
  membership_status: 'active',
};
const targetAdminResultRow = {
  organization_id: 'org_acme',
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'admin',
  membership_status: 'active',
};

function mutationInput(username = 'bob') {
  return {
    context: mutationContext,
    userId: membershipRow.user_account_id,
    organizationId: 'org_acme',
    username,
  } as const;
}

describe('PostgresOrganizationMembershipRepository', () => {
  it('resolves an active membership with organization status', async () => {
    const client = new FakePostgres();

    await expect(
      new PostgresOrganizationMembershipRepository(client).resolveMembership({
        context,
        userId: membershipRow.user_account_id,
        organizationId: membershipRow.organization_id,
      }),
    ).resolves.toEqual({
      kind: 'active',
      membership: {
        organizationId: 'org_acme',
        userId: 'usr_01J00000000000000000000000',
        organizationStatus: 'active',
        role: 'owner',
        status: 'active',
      },
    });

    expect(client.queries[0]?.values).toEqual([
      membershipRow.user_account_id,
      membershipRow.organization_id,
    ]);
    expect(client.queries[0]?.text).toContain(
      'membership.user_account_id = $1',
    );
    expect(client.queries[0]?.text).toContain(
      'membership.organization_id = $2',
    );
  });

  it('distinguishes a disabled membership internally', async () => {
    const client = new FakePostgres();
    client.result = [{ ...membershipRow, membership_status: 'disabled' }];

    await expect(
      new PostgresOrganizationMembershipRepository(client).resolveMembership({
        context,
        userId: membershipRow.user_account_id,
        organizationId: membershipRow.organization_id,
      }),
    ).resolves.toMatchObject({ kind: 'disabled' });
  });

  it('returns missing when no durable membership exists', async () => {
    const client = new FakePostgres();
    client.result = [];

    await expect(
      new PostgresOrganizationMembershipRepository(client).resolveMembership({
        context,
        userId: membershipRow.user_account_id,
        organizationId: 'org_missing',
      }),
    ).resolves.toEqual({ kind: 'missing' });
  });

  it('uses active-only filters and preserves deterministic one-query reads', async () => {
    const client = new FakePostgres();
    client.result = rosterRows;

    await expect(
      new PostgresOrganizationMembershipRepository(client).listRoster({
        context,
        userId: membershipRow.user_account_id,
      }),
    ).resolves.toEqual([
      {
        organizationId: 'org_acme',
        name: 'Acme',
        status: 'active',
        membershipRole: 'owner',
        members: [
          { username: 'alice', role: 'owner' },
          { username: 'bob', role: 'member' },
        ],
      },
      {
        organizationId: 'org_suspended',
        name: 'Suspended',
        status: 'suspended',
        membershipRole: 'member',
        members: [{ username: 'alice', role: 'member' }],
      },
    ]);

    expect(client.queries[0]?.values).toEqual([membershipRow.user_account_id]);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.text).toContain("caller.status = 'active'");
    expect(client.queries[0]?.text).toContain("member.status = 'active'");
    expect(client.queries[0]?.text).toContain('ORDER BY');
  });

  it('returns an empty roster when the caller has no active membership', async () => {
    const client = new FakePostgres();
    client.result = [];

    await expect(
      new PostgresOrganizationMembershipRepository(client).listRoster({
        context,
        userId: membershipRow.user_account_id,
      }),
    ).resolves.toEqual([]);
  });

  it('fails closed on database errors and malformed projections', async () => {
    const client = new FakePostgres();
    client.shouldFail = true;

    const unavailable = await new PostgresOrganizationMembershipRepository(
      client,
    )
      .listRoster({ context, userId: membershipRow.user_account_id })
      .catch((error: unknown) => error);

    expect(unavailable).toBeInstanceOf(AppError);
    expect((unavailable as AppError).code).toBe('INTERNAL_ERROR');

    client.shouldFail = false;
    client.result = [{ ...membershipRow, role: 'superuser' }];
    const malformed = await new PostgresOrganizationMembershipRepository(client)
      .resolveMembership({
        context,
        userId: membershipRow.user_account_id,
        organizationId: membershipRow.organization_id,
      })
      .catch((error: unknown) => error);

    expect(malformed).toBeInstanceOf(AppError);
    expect((malformed as AppError).code).toBe('INTERNAL_ERROR');
    expect((malformed as AppError).message).toBe('Identity data is invalid');

    client.result = [{ ...membershipRow, user_account_id: 'usr_other' }];
    const mismatched = await new PostgresOrganizationMembershipRepository(
      client,
    )
      .resolveMembership({
        context,
        userId: membershipRow.user_account_id,
        organizationId: membershipRow.organization_id,
      })
      .catch((error: unknown) => error);

    expect(mismatched).toBeInstanceOf(AppError);
    expect((mismatched as AppError).code).toBe('INTERNAL_ERROR');
  });

  it('changes a member role inside a transaction after locking the organization and memberships', async () => {
    const client = new FakePostgres();
    client.transactionRows = [
      [organizationRow],
      [callerOwnerRow, targetMemberRow],
      [targetAdminResultRow],
    ];

    await expect(
      new PostgresOrganizationMembershipRepository(client).changeRole({
        ...mutationInput(),
        role: 'admin',
      }),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      username: 'bob',
      role: 'admin',
      status: 'active',
    });

    expect(client.transactionQueries[0]?.text).toContain('FOR UPDATE');
    expect(client.transactionQueries[1]?.text).toContain('FOR UPDATE');
    expect(client.transactionQueries[1]?.text).toContain('ORDER BY');
    expect(client.transactionQueries.at(-1)?.text).toContain('UPDATE');
  });

  it('rejects demoting the last active owner with a conflict', async () => {
    const client = new FakePostgres();
    client.transactionRows = [
      [organizationRow],
      [callerOwnerRow, { ...targetMemberRow, role: 'owner' }],
      [{ owner_count: '1' }],
    ];

    await expect(
      new PostgresOrganizationMembershipRepository(client).changeRole({
        ...mutationInput(),
        role: 'member',
      }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_OWNER_REQUIRED' });
  });

  it('hides an unknown target from a member with not-found', async () => {
    const client = new FakePostgres();
    client.transactionRows = [
      [organizationRow],
      [{ ...callerOwnerRow, role: 'member' }],
    ];

    await expect(
      new PostgresOrganizationMembershipRepository(client).changeRole({
        ...mutationInput('missing'),
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns an already-disabled target without reactivating or deleting it', async () => {
    const client = new FakePostgres();
    const disabled = { ...targetMemberRow, membership_status: 'disabled' };
    client.transactionRows = [[organizationRow], [callerOwnerRow, disabled]];

    await expect(
      new PostgresOrganizationMembershipRepository(client).disable(
        mutationInput(),
      ),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      username: 'bob',
      role: 'member',
      status: 'disabled',
    });
    expect(client.transactionQueries).toHaveLength(2);
  });

  it('transfers ownership atomically and returns the promoted target', async () => {
    const client = new FakePostgres();
    client.transactionRows = [
      [organizationRow],
      [callerOwnerRow, targetMemberRow],
      [
        {
          ...targetMemberRow,
          role: 'owner',
        },
      ],
      [{}],
    ];

    await expect(
      new PostgresOrganizationMembershipRepository(client).transfer(
        mutationInput(),
      ),
    ).resolves.toEqual({
      organizationId: 'org_acme',
      username: 'bob',
      role: 'owner',
      status: 'active',
    });
    expect(client.transactionQueries.at(-2)?.text).toContain('UPDATE');
    expect(client.transactionQueries.at(-1)?.text).toContain('UPDATE');
  });
});
