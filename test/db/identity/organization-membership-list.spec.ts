import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

import {
  MembershipFixture,
  type QueryPause,
  REQUEST_ID,
  bearer,
  waitForQueryCapture,
} from './support/membership-fixture';

const ORGANIZATION_ID = 'org_membership_list';

let fixture: MembershipFixture;
let app: NestFastifyApplication;
let pool: Pool;
let ownerId: string;

async function seedAccount(
  username: string,
  status: 'active' | 'disabled' = 'active',
): Promise<string> {
  return fixture.seedAccount(username, status);
}

async function seedMembership(
  userAccountId: string,
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'disabled',
  organizationId = ORGANIZATION_ID,
): Promise<void> {
  await fixture.seedMembership(userAccountId, role, status, organizationId);
}

function listMemberships(
  userId: string,
  organizationId = ORGANIZATION_ID,
  query = '',
) {
  return app.inject({
    method: 'GET',
    url: `/v1/organizations/${organizationId}/members${query}`,
    headers: { authorization: bearer(userId) },
  });
}

beforeAll(async () => {
  fixture = new MembershipFixture({
    primaryOrganization: { id: ORGANIZATION_ID, name: 'Membership List' },
  });
  await fixture.boot();
  app = fixture.app;
  pool = fixture.pool;
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fixture.reseedPrimaryOrganization();
  ownerId = await seedAccount('owner');
  await seedMembership(ownerId, 'owner', 'active');
});

describe('Organization Membership List over HTTP and PostgreSQL', () => {
  it('returns the active membership projection by username without account state or identifiers', async () => {
    const disabledAccountId = await seedAccount(
      'zeta-disabled-account',
      'disabled',
    );
    await seedMembership(disabledAccountId, 'member', 'active');
    const disabledMembershipId = await seedAccount('inactive-membership');
    await seedMembership(disabledMembershipId, 'admin', 'disabled');
    const alphabeticallyFirstId = await seedAccount(
      'alpha-disabled-account',
      'disabled',
    );
    await seedMembership(alphabeticallyFirstId, 'member', 'active');

    const response = await listMemberships(ownerId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        members: [
          {
            username: 'alpha-disabled-account',
            role: 'member',
            status: 'active',
          },
          { username: 'owner', role: 'owner', status: 'active' },
          {
            username: 'zeta-disabled-account',
            role: 'member',
            status: 'active',
          },
        ],
        next_cursor: null,
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(response.payload).not.toContain(ownerId);
    expect(response.payload).not.toContain(disabledAccountId);
    expect(response.payload).not.toContain('@');
  });

  it('lets an active admin list disabled memberships only when requested', async () => {
    const adminId = await seedAccount('admin');
    await seedMembership(adminId, 'admin', 'active');
    const disabledId = await seedAccount('disabled-member');
    await seedMembership(disabledId, 'member', 'disabled');

    const response = await listMemberships(
      adminId,
      ORGANIZATION_ID,
      '?status=disabled',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        members: [
          { username: 'disabled-member', role: 'member', status: 'disabled' },
        ],
        next_cursor: null,
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns an empty list when the requested membership status has no matches', async () => {
    const response = await listMemberships(
      ownerId,
      ORGANIZATION_ID,
      '?status=disabled',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { members: [], next_cursor: null },
      meta: { request_id: REQUEST_ID },
    });
  });

  it.each([
    ['an unsupported value', '?status=all'],
    ['a repeated filter', '?status=active&status=disabled'],
    ['an unknown query key', '?status=active&all=true'],
  ])('rejects %s as an invalid request', async (_label, query) => {
    const response = await listMemberships(ownerId, ORGANIZATION_ID, query);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('gives callers without active manager authority the same denial', async () => {
    const memberId = await seedAccount('ordinary-member');
    await seedMembership(memberId, 'member', 'active');
    const disabledMembershipId = await seedAccount('disabled-caller');
    await seedMembership(disabledMembershipId, 'owner', 'disabled');
    const outsiderId = await seedAccount('outsider');
    const suspendedOwnerId = await seedAccount('suspended-owner');
    await seedMembership(suspendedOwnerId, 'owner', 'active');

    const memberResponse = await listMemberships(memberId);
    const disabledResponse = await listMemberships(disabledMembershipId);
    const outsiderResponse = await listMemberships(outsiderId);
    await pool.query(
      "UPDATE organizations SET status = 'suspended' WHERE id = $1",
      [ORGANIZATION_ID],
    );
    const suspendedResponse = await listMemberships(suspendedOwnerId);

    const denial = {
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'Organization membership list access is forbidden',
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    };
    for (const response of [
      memberResponse,
      disabledResponse,
      outsiderResponse,
      suspendedResponse,
    ]) {
      const body: unknown = response.json();
      expect({ status: response.statusCode, body }).toEqual(denial);
    }
  });

  it('does not reveal members when an owner names another organization', async () => {
    await pool.query(
      "INSERT INTO organizations (id, name, status) VALUES ($1, $2, 'active')",
      ['org_other_members', 'Other Organization'],
    );
    const foreignOwnerId = await seedAccount('foreign-owner');
    const foreignMemberId = await seedAccount('foreign-member');
    await seedMembership(
      foreignOwnerId,
      'owner',
      'active',
      'org_other_members',
    );
    await seedMembership(
      foreignMemberId,
      'member',
      'active',
      'org_other_members',
    );

    const response = await listMemberships(ownerId, 'org_other_members');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'FORBIDDEN',
        message: 'Organization membership list access is forbidden',
      },
    });
    expect(response.payload).not.toContain('foreign-member');
  });

  it('returns the snapshot read before a concurrent authority change without locking the membership', async () => {
    const holder = await pool.connect();
    let transactionOpen = false;
    let request: ReturnType<typeof app.inject> | undefined;
    let pause: QueryPause | undefined;

    try {
      await holder.query('BEGIN');
      transactionOpen = true;
      await holder.query(
        `UPDATE organization_members SET status = 'disabled'
         WHERE organization_id = $1 AND user_account_id = $2`,
        [ORGANIZATION_ID, ownerId],
      );

      pause = fixture.identityClient.pauseAfterNextQuery();
      request = listMemberships(ownerId);
      await waitForQueryCapture(pause);

      await holder.query('COMMIT');
      transactionOpen = false;
      pause.release();

      const snapshotResponse = await request;
      expect(snapshotResponse.statusCode).toBe(200);
      const members = snapshotResponse.json<{
        data: { members: unknown[] };
      }>().data.members;
      expect(members).toContainEqual({
        username: 'owner',
        role: 'owner',
        status: 'active',
      });
      expect((await listMemberships(ownerId)).statusCode).toBe(403);
    } finally {
      pause?.release();
      if (transactionOpen) {
        await holder.query('ROLLBACK');
      }
      holder.release();
      await request?.catch(() => undefined);
    }
  });

  describe('keyset pagination over PostgreSQL', () => {
    it('pages through members across first, middle, and last page', async () => {
      for (const name of ['member-a', 'member-b', 'member-c', 'member-d']) {
        const id = await seedAccount(name);
        await seedMembership(id, 'member', 'active');
      }

      const firstResponse = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        '?limit=2',
      );
      expect(firstResponse.statusCode).toBe(200);
      const firstBody = firstResponse.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(firstBody.data.members.map((m) => m.username)).toEqual([
        'member-a',
        'member-b',
      ]);
      expect(typeof firstBody.data.next_cursor).toBe('string');
      const cursor1 = firstBody.data.next_cursor;
      expect(cursor1).not.toBeNull();

      const middleResponse = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor1 as string)}`,
      );
      expect(middleResponse.statusCode).toBe(200);
      const middleBody = middleResponse.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(middleBody.data.members.map((m) => m.username)).toEqual([
        'member-c',
        'member-d',
      ]);
      expect(typeof middleBody.data.next_cursor).toBe('string');
      const cursor2 = middleBody.data.next_cursor;
      expect(cursor2).not.toBeNull();

      const lastResponse = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor2 as string)}`,
      );
      expect(lastResponse.statusCode).toBe(200);
      const lastBody = lastResponse.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(lastBody.data.members.map((m) => m.username)).toEqual(['owner']);
      expect(lastBody.data.next_cursor).toBeNull();
    });

    it('returns an unchanged row exactly once across pages', async () => {
      for (const name of ['user-alpha', 'user-bravo', 'user-charlie']) {
        const id = await seedAccount(name);
        await seedMembership(id, 'member', 'active');
      }

      const page1 = await listMemberships(ownerId, ORGANIZATION_ID, '?limit=2');
      const page1Body = page1.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      const cursor = page1Body.data.next_cursor;
      expect(cursor).not.toBeNull();

      const page2 = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor as string)}`,
      );
      const page2Body = page2.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();

      const names1 = page1Body.data.members.map((m) => m.username);
      const names2 = page2Body.data.members.map((m) => m.username);
      for (const name of names1) {
        expect(names2).not.toContain(name);
      }
      expect(names1.concat(names2)).toEqual([
        'owner',
        'user-alpha',
        'user-bravo',
        'user-charlie',
      ]);
    });

    it('re-evaluates authorization and denies access when caller loses authority between pages', async () => {
      const adminId = await seedAccount('admin-caller');
      await seedMembership(adminId, 'admin', 'active');
      for (const name of ['user-1', 'user-2', 'user-3']) {
        const id = await seedAccount(name);
        await seedMembership(id, 'member', 'active');
      }

      const page1 = await listMemberships(adminId, ORGANIZATION_ID, '?limit=2');
      expect(page1.statusCode).toBe(200);
      const cursor = page1.json<{ data: { next_cursor: string | null } }>().data
        .next_cursor;
      expect(cursor).not.toBeNull();

      await pool.query(
        "UPDATE organization_members SET status = 'disabled' WHERE organization_id = $1 AND user_account_id = $2",
        [ORGANIZATION_ID, adminId],
      );

      const page2 = await listMemberships(
        adminId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor as string)}`,
      );
      expect(page2.statusCode).toBe(403);
      expect(page2.json()).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'Organization membership list access is forbidden',
        },
      });
    });

    it('continues keyset traversal when a member is removed between pages', async () => {
      const id1 = await seedAccount('member-1');
      await seedMembership(id1, 'member', 'active');
      const id2 = await seedAccount('member-2');
      await seedMembership(id2, 'member', 'active');
      const id3 = await seedAccount('member-3');
      await seedMembership(id3, 'member', 'active');

      const page1 = await listMemberships(ownerId, ORGANIZATION_ID, '?limit=2');
      expect(page1.statusCode).toBe(200);
      const page1Body = page1.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(page1Body.data.members.map((m) => m.username)).toEqual([
        'member-1',
        'member-2',
      ]);
      const cursor = page1Body.data.next_cursor;
      expect(cursor).not.toBeNull();

      await pool.query(
        'DELETE FROM organization_members WHERE organization_id = $1 AND user_account_id = $2',
        [ORGANIZATION_ID, id3],
      );

      const page2 = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor as string)}`,
      );
      expect(page2.statusCode).toBe(200);
      const page2Body = page2.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(page2Body.data.members.map((m) => m.username)).toEqual(['owner']);
      expect(page2Body.data.next_cursor).toBeNull();
    });

    it('ends with next_cursor null on a last page that is exactly full', async () => {
      for (const name of ['member-a', 'member-b', 'member-c']) {
        await seedMembership(await seedAccount(name), 'member', 'active');
      }

      const first = await listMemberships(ownerId, ORGANIZATION_ID, '?limit=2');
      const cursor = first.json<{ data: { next_cursor: string | null } }>().data
        .next_cursor;
      const last = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor ?? '')}`,
      );

      const body = last.json<{
        data: { members: { username: string }[]; next_cursor: string | null };
      }>();
      expect(body.data.members.map((m) => m.username)).toEqual([
        'member-c',
        'owner',
      ]);
      expect(body.data.next_cursor).toBeNull();
    });

    it('returns an empty page when the rows after the cursor are gone', async () => {
      const first = await seedAccount('zz-1');
      await seedMembership(first, 'member', 'active');
      const second = await seedAccount('zz-2');
      await seedMembership(second, 'member', 'active');

      const page1 = await listMemberships(ownerId, ORGANIZATION_ID, '?limit=2');
      const cursor = page1.json<{ data: { next_cursor: string | null } }>().data
        .next_cursor;
      await pool.query(
        'DELETE FROM organization_members WHERE organization_id = $1 AND user_account_id = $2',
        [ORGANIZATION_ID, second],
      );

      const page2 = await listMemberships(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(cursor ?? '')}`,
      );

      expect(page2.statusCode).toBe(200);
      expect(page2.json()).toMatchObject({
        data: { members: [], next_cursor: null },
      });
    });
  });
});
