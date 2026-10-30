import { ulid } from 'ulid';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { ORGANIZATION_MEMBERSHIP } from '@/modules/identity/membership/application/organization-membership.port';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/membership/infrastructure/postgres-organization-membership.repository';
import { rosterCursorScope } from '@/modules/identity/membership/presentation/organization-roster-query';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const REQUEST_ID = 'req_01J00000000000000000000000';
const NOW = new Date('2026-10-30T12:00:00.000Z');
const ROSTER_URL = '/v1/organizations/me/members';

let app: NestFastifyApplication;
let pool: Pool;
let callerId: string;

interface RosterOrganization {
  readonly organization_id: string;
  readonly status: string;
  readonly member_count: number;
  readonly members: readonly { username: string; role: string }[];
}

interface RosterPage {
  readonly data: {
    readonly organizations: readonly RosterOrganization[];
    readonly next_cursor: string | null;
  };
}

function bearer(userId: string): string {
  return `Bearer ${userId}.token.value`;
}

async function seedAccount(username: string): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [id, username, NOW],
  );
  return id;
}

async function seedOrganization(
  id: string,
  status: 'active' | 'suspended' = 'active',
): Promise<void> {
  await pool.query(
    'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
    [id, `Name of ${id}`, status],
  );
}

async function seedMembership(
  organizationId: string,
  userAccountId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
  status: 'active' | 'disabled' = 'active',
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [organizationId, userAccountId, role, status, NOW],
  );
}

async function joinCaller(
  organizationId: string,
  role: 'owner' | 'admin' | 'member' = 'owner',
): Promise<void> {
  await seedMembership(organizationId, callerId, role);
}

function roster(userId: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `${ROSTER_URL}${query}`,
    headers: { authorization: bearer(userId) },
  });
}

async function rosterPage(userId: string, query = ''): Promise<RosterPage> {
  const response = await roster(userId, query);
  expect(response.statusCode).toBe(200);
  return response.json<RosterPage>();
}

function ids(page: RosterPage): readonly string[] {
  return page.data.organizations.map((item) => item.organization_id);
}

beforeAll(async () => {
  pool = createTestPool();
  const membership = new PostgresOrganizationMembershipRepository(
    createPostgresIdentityClient(testDatabaseUrl()),
  );
  const verifier: UserAccessTokenVerifierPort = {
    verify: async (token) => ({
      userId: token.split('.')[0] ?? '',
      jti: 'jti_01',
    }),
  };
  const userAccounts = userAccountStatus(async (userId) => {
    const result = await pool.query<{ status: 'active' | 'disabled' }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    return result.rows[0]?.status;
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ORGANIZATION_MEMBERSHIP)
    .useValue(membership)
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(USER_ACCOUNT_REPOSITORY)
    .useValue(userAccounts)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: () => REQUEST_ID }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  callerId = await seedAccount('owner');
});

describe('Organization roster pagination over HTTP and PostgreSQL', () => {
  it('cuts pages between Organizations and never splits one', async () => {
    const other = await seedAccount('other');
    const third = await seedAccount('third');
    for (const organizationId of [
      'org_roster_a',
      'org_roster_b',
      'org_roster_c',
    ]) {
      await seedOrganization(organizationId);
      await joinCaller(organizationId);
    }
    await seedMembership('org_roster_a', other);
    await seedMembership('org_roster_b', other);
    await seedMembership('org_roster_b', third);

    const first = await rosterPage(callerId, '?limit=2');
    expect(ids(first)).toEqual(['org_roster_a', 'org_roster_b']);
    expect(first.data.organizations.map((item) => item.member_count)).toEqual([
      2, 3,
    ]);
    expect(first.data.organizations.map((item) => item.members.length)).toEqual(
      [2, 3],
    );
    expect(first.data.next_cursor).toEqual(expect.any(String));

    const second = await rosterPage(
      callerId,
      `?limit=2&cursor=${String(first.data.next_cursor)}`,
    );
    expect(ids(second)).toEqual(['org_roster_c']);
    expect(second.data.next_cursor).toBeNull();
  });

  it('ends with a null cursor when the last page is exactly full', async () => {
    for (const organizationId of ['org_roster_a', 'org_roster_b']) {
      await seedOrganization(organizationId);
      await joinCaller(organizationId);
    }

    const page = await rosterPage(callerId, '?limit=2');

    expect(ids(page)).toEqual(['org_roster_a', 'org_roster_b']);
    expect(page.data.next_cursor).toBeNull();
  });

  it('caps the members of a large Organization and reports their total', async () => {
    await seedOrganization('org_roster_big');
    await joinCaller('org_roster_big');
    for (let index = 1; index <= 104; index += 1) {
      await seedMembership(
        'org_roster_big',
        await seedAccount(`a${String(index).padStart(3, '0')}`),
      );
    }

    const page = await rosterPage(callerId);
    const big = page.data.organizations[0];

    expect(big?.member_count).toBe(105);
    expect(big?.members).toHaveLength(100);
    expect(big?.members[0]?.username).toBe('a001');
    expect(big?.members[99]?.username).toBe('a100');
  });

  it('leaves disabled members out of the list and the count', async () => {
    await seedOrganization('org_roster_a');
    await joinCaller('org_roster_a');
    await seedMembership(
      'org_roster_a',
      await seedAccount('gone'),
      'member',
      'disabled',
    );

    const page = await rosterPage(callerId);

    expect(page.data.organizations[0]?.member_count).toBe(1);
    expect(page.data.organizations[0]?.members).toEqual([
      { username: 'owner', role: 'owner' },
    ]);
  });

  it('keeps a suspended Organization in the roster', async () => {
    await seedOrganization('org_roster_a', 'suspended');
    await joinCaller('org_roster_a');

    const page = await rosterPage(callerId);

    expect(page.data.organizations).toMatchObject([
      { organization_id: 'org_roster_a', status: 'suspended' },
    ]);
  });

  it('does not list an Organization the caller does not belong to', async () => {
    const other = await seedAccount('other');
    await seedOrganization('org_roster_a');
    await seedMembership('org_roster_a', other, 'owner');
    await seedOrganization('org_roster_b');
    await joinCaller('org_roster_b');

    const page = await rosterPage(callerId);

    expect(ids(page)).toEqual(['org_roster_b']);
    expect(JSON.stringify(page)).not.toContain('other');
  });

  it('answers an empty roster to a caller with no active membership', async () => {
    await seedOrganization('org_roster_a');
    await seedMembership('org_roster_a', callerId, 'member', 'disabled');

    const page = await rosterPage(callerId);

    expect(page.data).toEqual({ organizations: [], next_cursor: null });
  });

  it('checks membership again on every page', async () => {
    for (const organizationId of [
      'org_roster_a',
      'org_roster_b',
      'org_roster_c',
    ]) {
      await seedOrganization(organizationId);
      await joinCaller(organizationId);
    }

    const first = await rosterPage(callerId, '?limit=1');
    expect(ids(first)).toEqual(['org_roster_a']);

    await pool.query(
      `UPDATE organization_members SET status = 'disabled'
       WHERE organization_id = 'org_roster_b' AND user_account_id = $1`,
      [callerId],
    );

    const second = await rosterPage(
      callerId,
      `?limit=1&cursor=${String(first.data.next_cursor)}`,
    );
    expect(ids(second)).toEqual(['org_roster_c']);
    expect(second.data.next_cursor).toBeNull();
  });

  it('returns nothing, without error, for a cursor past the last Organization', async () => {
    await seedOrganization('org_roster_a');
    await joinCaller('org_roster_a');
    const cursor = encodeCursor(
      { organizationId: 'org_roster_zzz' },
      rosterCursorScope(callerId),
    );

    const page = await rosterPage(callerId, `?cursor=${cursor}`);

    expect(page.data).toEqual({ organizations: [], next_cursor: null });
  });

  it('refuses a cursor another caller received, a malformed one, and a stale one', async () => {
    await seedOrganization('org_roster_a');
    await joinCaller('org_roster_a');
    const otherId = await seedAccount('other');
    const foreign = encodeCursor(
      { organizationId: 'org_roster_a' },
      rosterCursorScope(otherId),
    );

    const stale = Buffer.from(
      JSON.stringify({ v: 2, pos: { organizationId: 'org_roster_a' }, s: 'x' }),
    ).toString('base64url');

    for (const cursor of [foreign, 'not-a-cursor', stale]) {
      const response = await roster(callerId, `?cursor=${cursor}`);
      expect(response.statusCode).toBe(400);
      expect(response.json<unknown>()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    }
  });

  it('refuses a limit outside 1 to 100', async () => {
    for (const limit of ['0', '101']) {
      const response = await roster(callerId, `?limit=${limit}`);
      expect(response.statusCode).toBe(400);
    }
  });
});
