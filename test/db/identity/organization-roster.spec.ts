import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

import { rosterCursorScope } from '@/modules/identity/membership/presentation/organization-roster-query';
import { encodeCursor } from '@/modules/identity/shared/presentation/cursor-codec';

import { MembershipFixture, bearer } from './support/membership-fixture';

const ROSTER_URL = '/v1/organizations/me/members';

let fixture: MembershipFixture;
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

async function seedAccount(username: string): Promise<string> {
  return fixture.seedAccount(username);
}

async function seedOrganization(
  id: string,
  status: 'active' | 'suspended' = 'active',
): Promise<void> {
  await fixture.seedOrganization(id, status);
}

async function seedMembership(
  organizationId: string,
  userAccountId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
  status: 'active' | 'disabled' = 'active',
): Promise<void> {
  await fixture.seedMembership(userAccountId, role, status, organizationId);
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
  fixture = new MembershipFixture({
    now: new Date('2026-10-30T12:00:00.000Z'),
  });
  await fixture.boot();
  app = fixture.app;
  pool = fixture.pool;
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fixture.reset();
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
