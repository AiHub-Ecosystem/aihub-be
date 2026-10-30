import { createHash, randomBytes } from 'node:crypto';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppModule } from '@/app.module';
import { createCliRuntimeSecretProvider } from '@/cli/runtime-secret-provider';
import {
  type ListOpenOrganizationInvitationsResponse,
  ListOpenOrganizationInvitationsResponseSchema,
} from '@/contracts/organization/invitation';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import {
  ORGANIZATION_INVITATION,
  type OrganizationInvitationPort,
} from '@/modules/identity/invitations/application/organization-invitation.port';
import { PostgresOrganizationInvitationRepository } from '@/modules/identity/invitations/infrastructure/postgres-organization-invitation.repository';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipRole,
} from '@/modules/identity/membership/application/organization-membership.port';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/membership/infrastructure/postgres-organization-membership.repository';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';
import { createDatabaseTestEmailOutbox } from '../shared/email-outbox';

const ORGANIZATION_ID = 'org_invitation_list';
const REQUEST_ID = 'req_01J00000000000000000000000';
const BASE_TIME = Date.now();
const NOW = new Date(BASE_TIME);
const EXPIRES_AT = new Date(BASE_TIME + 30 * 86400000);

function invitationListBody(response: {
  json: () => unknown;
}): ListOpenOrganizationInvitationsResponse {
  return Value.Parse(
    ListOpenOrganizationInvitationsResponseSchema,
    response.json(),
  );
}

let app: NestFastifyApplication;
let pool: Pool;
let ownerId: string;
let adminId: string;
let memberId: string;

function bearer(userId: string): string {
  return `Bearer ${userId}.token.value`;
}

function tokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

async function seedAccount(
  username: string,
  status: 'active' | 'disabled' = 'active',
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [id, username, status, NOW],
  );
  return id;
}

async function seedMembership(
  userAccountId: string,
  role: OrganizationMembershipRole,
  status: 'active' | 'disabled' = 'active',
  organizationId = ORGANIZATION_ID,
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [organizationId, userAccountId, role, status, NOW],
  );
}

async function seedInvitationRow(row: {
  readonly id: string;
  readonly organizationId?: string;
  readonly email: string;
  readonly role?: OrganizationMembershipRole;
  readonly invitedBy: string;
  readonly tokenHash?: string;
  readonly expiresAt?: Date;
  readonly consumedAt?: Date | null;
  readonly createdAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO organization_invitations (
       id, organization_id, email, role, invited_by, token_hash,
       expires_at, consumed_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.id,
      row.organizationId ?? ORGANIZATION_ID,
      row.email,
      row.role ?? 'member',
      row.invitedBy,
      row.tokenHash ?? tokenHash(),
      row.expiresAt ?? EXPIRES_AT,
      row.consumedAt ?? null,
      row.createdAt,
    ],
  );
}

function listInvitations(
  userId: string,
  organizationId = ORGANIZATION_ID,
  query = '',
) {
  return app.inject({
    method: 'GET',
    url: `/v1/organizations/${organizationId}/invitations${query}`,
    headers: { authorization: bearer(userId) },
  });
}

beforeAll(async () => {
  pool = createTestPool();
  const identityClient = createPostgresIdentityClient(testDatabaseUrl());
  const membership = new PostgresOrganizationMembershipRepository(
    identityClient,
  );
  const secrets = createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const invitationRepo: OrganizationInvitationPort =
    new PostgresOrganizationInvitationRepository(
      identityClient,
      createDatabaseTestEmailOutbox(secrets),
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
    .overrideProvider(ORGANIZATION_INVITATION)
    .useValue(invitationRepo)
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
  await pool.query(
    'INSERT INTO organizations (id, name, status) VALUES ($1, $2, $3)',
    [ORGANIZATION_ID, 'Invitation List Test Org', 'active'],
  );
  ownerId = await seedAccount('inv_owner');
  adminId = await seedAccount('inv_admin');
  memberId = await seedAccount('inv_member');

  await seedMembership(ownerId, 'owner', 'active');
  await seedMembership(adminId, 'admin', 'active');
  await seedMembership(memberId, 'member', 'active');
});

describe('Organization Invitation List keyset pagination over PostgreSQL', () => {
  it('paginates across first, middle, and last page with correct ordering and bounds', async () => {
    const d1 = new Date(BASE_TIME - 1000 * 60);
    const d2 = new Date(BASE_TIME - 1000 * 120);
    const d3 = new Date(BASE_TIME - 1000 * 180);
    const d4 = new Date(BASE_TIME - 1000 * 240);
    const d5 = new Date(BASE_TIME - 1000 * 300);

    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000001',
      email: 'user1@example.com',
      invitedBy: ownerId,
      createdAt: d1,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000002',
      email: 'user2@example.com',
      invitedBy: ownerId,
      createdAt: d2,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000003',
      email: 'user3@example.com',
      invitedBy: ownerId,
      createdAt: d3,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000004',
      email: 'user4@example.com',
      invitedBy: ownerId,
      createdAt: d4,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000005',
      email: 'user5@example.com',
      invitedBy: ownerId,
      createdAt: d5,
    });

    // Page 1: limit 2 -> returns item 1 and 2, next_cursor points to item 2
    const page1Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      '?limit=2',
    );
    expect(page1Res.statusCode).toBe(200);
    const page1 = invitationListBody(page1Res);
    expect(page1.data.invitations).toHaveLength(2);
    expect(page1.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J00000000000000000000001',
    );
    expect(page1.data.invitations[1]?.invitation_id).toBe(
      'oiv_01J00000000000000000000002',
    );
    expect(typeof page1.data.next_cursor).toBe('string');

    // Page 2: limit 2 with cursor from Page 1 -> returns item 3 and 4
    const page2Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=2&cursor=${encodeURIComponent(page1.data.next_cursor ?? '')}`,
    );
    expect(page2Res.statusCode).toBe(200);
    const page2 = invitationListBody(page2Res);
    expect(page2.data.invitations).toHaveLength(2);
    expect(page2.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J00000000000000000000003',
    );
    expect(page2.data.invitations[1]?.invitation_id).toBe(
      'oiv_01J00000000000000000000004',
    );
    expect(typeof page2.data.next_cursor).toBe('string');

    // Page 3: limit 2 with cursor from Page 2 -> returns item 5 and null next_cursor
    const page3Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=2&cursor=${encodeURIComponent(page2.data.next_cursor ?? '')}`,
    );
    expect(page3Res.statusCode).toBe(200);
    const page3 = invitationListBody(page3Res);
    expect(page3.data.invitations).toHaveLength(1);
    expect(page3.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J00000000000000000000005',
    );
    expect(page3.data.next_cursor).toBeNull();
  });

  it('breaks ties deterministically using id ascending when rows have equal created_at', async () => {
    const sameTime = new Date(BASE_TIME - 1000 * 60);

    // Insert out of id order
    await seedInvitationRow({
      id: 'oiv_01J0000000000000000000000C',
      email: 'c@example.com',
      invitedBy: ownerId,
      createdAt: sameTime,
    });
    await seedInvitationRow({
      id: 'oiv_01J0000000000000000000000A',
      email: 'a@example.com',
      invitedBy: ownerId,
      createdAt: sameTime,
    });
    await seedInvitationRow({
      id: 'oiv_01J0000000000000000000000B',
      email: 'b@example.com',
      invitedBy: ownerId,
      createdAt: sameTime,
    });

    const page1Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      '?limit=2',
    );
    expect(page1Res.statusCode).toBe(200);
    const page1 = invitationListBody(page1Res);
    expect(page1.data.invitations).toHaveLength(2);
    expect(page1.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J0000000000000000000000A',
    );
    expect(page1.data.invitations[1]?.invitation_id).toBe(
      'oiv_01J0000000000000000000000B',
    );

    const page2Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=2&cursor=${encodeURIComponent(page1.data.next_cursor ?? '')}`,
    );
    expect(page2Res.statusCode).toBe(200);
    const page2 = invitationListBody(page2Res);
    expect(page2.data.invitations).toHaveLength(1);
    expect(page2.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J0000000000000000000000C',
    );
    expect(page2.data.next_cursor).toBeNull();
  });

  it('re-evaluates authorization on every page: caller losing access between pages is refused with 403', async () => {
    const d1 = new Date(BASE_TIME - 1000 * 60);
    const d2 = new Date(BASE_TIME - 1000 * 120);

    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000001',
      email: 'one@example.com',
      invitedBy: adminId,
      createdAt: d1,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000002',
      email: 'two@example.com',
      invitedBy: adminId,
      createdAt: d2,
    });

    // Page 1 succeeds for admin
    const page1Res = await listInvitations(
      adminId,
      ORGANIZATION_ID,
      '?limit=1',
    );
    expect(page1Res.statusCode).toBe(200);
    const page1 = invitationListBody(page1Res);
    const cursor = page1.data.next_cursor;
    expect(typeof cursor).toBe('string');

    // Demote admin to member before page 2
    await pool.query(
      "UPDATE organization_members SET role = 'member' WHERE organization_id = $1 AND user_account_id = $2",
      [ORGANIZATION_ID, adminId],
    );

    // Page 2 with valid cursor fails because caller is no longer owner/admin
    const page2Res = await listInvitations(
      adminId,
      ORGANIZATION_ID,
      `?limit=1&cursor=${encodeURIComponent(cursor ?? '')}`,
    );
    expect(page2Res.statusCode).toBe(403);
    expect(page2Res.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });

  it('reflects live read semantics: an invitation consumed or expired between requests disappears', async () => {
    const d1 = new Date(BASE_TIME - 1000 * 60);
    const d2 = new Date(BASE_TIME - 1000 * 120);
    const d3 = new Date(BASE_TIME - 1000 * 180);

    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000001',
      email: 'inv1@example.com',
      invitedBy: ownerId,
      createdAt: d1,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000002',
      email: 'inv2@example.com',
      invitedBy: ownerId,
      createdAt: d2,
    });
    await seedInvitationRow({
      id: 'oiv_01J00000000000000000000003',
      email: 'inv3@example.com',
      invitedBy: ownerId,
      createdAt: d3,
    });

    // Fetch page 1 (gets item 1)
    const page1Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      '?limit=1',
    );
    expect(page1Res.statusCode).toBe(200);
    const page1 = invitationListBody(page1Res);
    const cursor = page1.data.next_cursor;

    // Concurrently consume item 2 (mark as consumed)
    await pool.query(
      'UPDATE organization_invitations SET consumed_at = NOW() WHERE id = $1',
      ['oiv_01J00000000000000000000002'],
    );

    // Page 2 should skip consumed item 2 and return item 3
    const page2Res = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=1&cursor=${encodeURIComponent(cursor ?? '')}`,
    );
    expect(page2Res.statusCode).toBe(200);
    const page2 = invitationListBody(page2Res);
    expect(page2.data.invitations).toHaveLength(1);
    expect(page2.data.invitations[0]?.invitation_id).toBe(
      'oiv_01J00000000000000000000003',
    );
    expect(page2.data.next_cursor).toBeNull();
  });

  it('returns each unchanged row exactly once across traversal', async () => {
    const items = [
      {
        id: 'oiv_01J00000000000000000000001',
        d: new Date(BASE_TIME - 1000 * 60),
      },
      {
        id: 'oiv_01J00000000000000000000002',
        d: new Date(BASE_TIME - 1000 * 120),
      },
      {
        id: 'oiv_01J00000000000000000000003',
        d: new Date(BASE_TIME - 1000 * 180),
      },
      {
        id: 'oiv_01J00000000000000000000004',
        d: new Date(BASE_TIME - 1000 * 240),
      },
    ];

    for (const item of items) {
      await seedInvitationRow({
        id: item.id,
        email: `${item.id}@example.com`,
        invitedBy: ownerId,
        createdAt: item.d,
      });
    }

    const collectedIds: string[] = [];
    let nextCursor: string | null = null;

    do {
      const query = nextCursor
        ? `?limit=2&cursor=${encodeURIComponent(nextCursor)}`
        : '?limit=2';
      const res = await listInvitations(ownerId, ORGANIZATION_ID, query);
      expect(res.statusCode).toBe(200);
      const body = invitationListBody(res);
      for (const inv of body.data.invitations) {
        collectedIds.push(inv.invitation_id);
      }
      nextCursor = body.data.next_cursor;
    } while (nextCursor !== null);

    expect(collectedIds).toEqual([
      'oiv_01J00000000000000000000001',
      'oiv_01J00000000000000000000002',
      'oiv_01J00000000000000000000003',
      'oiv_01J00000000000000000000004',
    ]);
    expect(new Set(collectedIds).size).toBe(4);
  });

  it('ends with next_cursor null on a last page that is exactly full', async () => {
    for (const n of [1, 2, 3, 4]) {
      await seedInvitationRow({
        id: `oiv_01J0000000000000000000000${n}`,
        email: `full${n}@example.com`,
        invitedBy: ownerId,
        createdAt: new Date(BASE_TIME - 1000 * 60 * n),
      });
    }

    const first = invitationListBody(
      await listInvitations(ownerId, ORGANIZATION_ID, '?limit=2'),
    );
    const last = invitationListBody(
      await listInvitations(
        ownerId,
        ORGANIZATION_ID,
        `?limit=2&cursor=${encodeURIComponent(first.data.next_cursor ?? '')}`,
      ),
    );

    expect(last.data.invitations).toHaveLength(2);
    expect(last.data.next_cursor).toBeNull();
  });

  it('returns an empty page when the rows after the cursor are gone', async () => {
    for (const n of [1, 2, 3]) {
      await seedInvitationRow({
        id: `oiv_01J0000000000000000000000${n}`,
        email: `gone${n}@example.com`,
        invitedBy: ownerId,
        createdAt: new Date(BASE_TIME - 1000 * 60 * n),
      });
    }
    const first = invitationListBody(
      await listInvitations(ownerId, ORGANIZATION_ID, '?limit=2'),
    );
    await pool.query('DELETE FROM organization_invitations WHERE id = $1', [
      'oiv_01J00000000000000000000003',
    ]);

    const response = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=2&cursor=${encodeURIComponent(first.data.next_cursor ?? '')}`,
    );

    expect(response.statusCode).toBe(200);
    const page = invitationListBody(response);
    expect(page.data.invitations).toEqual([]);
    expect(page.data.next_cursor).toBeNull();
  });

  it('closes the surface when the Organization is suspended between pages', async () => {
    for (const n of [1, 2, 3]) {
      await seedInvitationRow({
        id: `oiv_01J0000000000000000000000${n}`,
        email: `susp${n}@example.com`,
        invitedBy: ownerId,
        createdAt: new Date(BASE_TIME - 1000 * 60 * n),
      });
    }
    const first = invitationListBody(
      await listInvitations(ownerId, ORGANIZATION_ID, '?limit=2'),
    );
    await pool.query(
      "UPDATE organizations SET status = 'suspended' WHERE id = $1",
      [ORGANIZATION_ID],
    );

    const response = await listInvitations(
      ownerId,
      ORGANIZATION_ID,
      `?limit=2&cursor=${encodeURIComponent(first.data.next_cursor ?? '')}`,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
