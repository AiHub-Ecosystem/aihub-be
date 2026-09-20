import { AppError } from '../../../common/errors/app-error';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import type { PostgresIdentityClient } from './postgres-api-key.repository';
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

class FakePostgres implements PostgresIdentityClient {
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  result: readonly unknown[] = [membershipRow];
  shouldFail = false;

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

  it('groups the active roster in deterministic query order', async () => {
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
});
