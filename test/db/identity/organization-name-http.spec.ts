import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { ORGANIZATION_CREATION_RECORD } from '@/modules/identity/organizations/application/organization-creation-record.port';
import { ORGANIZATION_RENAME_RECORD } from '@/modules/identity/organizations/application/organization-rename-record.port';
import { PostgresOrganizationCreationRepository } from '@/modules/identity/organizations/infrastructure/postgres-organization-creation.repository';
import { PostgresOrganizationRenameRepository } from '@/modules/identity/organizations/infrastructure/postgres-organization-rename.repository';
import {
  type IdentityFixtureClient,
  createPostgresIdentityClient,
} from '@/modules/identity/shared/infrastructure/postgres-identity.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const REQUEST_ID = 'req_01J00000000000000000000000';

describe('Organization name validation over HTTP and PostgreSQL', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let identityClient: IdentityFixtureClient;
  let ownerId: string;

  beforeAll(async () => {
    pool = createTestPool();
    identityClient = createPostgresIdentityClient(testDatabaseUrl());
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token) => ({
        userId: token.split('.')[0] ?? '',
        jti: 'jti_owner',
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
      .overrideProvider(ORGANIZATION_CREATION_RECORD)
      .useValue(new PostgresOrganizationCreationRepository(identityClient))
      .overrideProvider(ORGANIZATION_RENAME_RECORD)
      .useValue(new PostgresOrganizationRenameRepository(identityClient))
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
    await identityClient.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetIdentityTables(pool);
    ownerId = `usr_${ulid()}`;
    await pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [ownerId, `owner-${ownerId.slice(4, 16).toLowerCase()}`],
    );
  });

  async function seedOrganization(): Promise<string> {
    const organizationId = `org_${ulid()}`;
    await pool.query(
      `INSERT INTO organizations
         (id, name, entitlements, rate_limit_rpm, max_concurrent,
          monthly_request_quota, hard_stop_on_quota)
       VALUES ($1, 'Acme', ARRAY['writing'], 60, 5, 100, true)`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO organization_members
         (organization_id, user_account_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [organizationId, ownerId],
    );
    return organizationId;
  }

  const rejectedNames = [
    ['a line break', 'Acme\nLtd'],
    ['a bidirectional override', 'Acme \u202Edtl'],
  ] as const;

  it.each(rejectedNames)(
    'rejects creation with %s without inserting an Organization',
    async (_reason, name) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { authorization: `Bearer ${ownerId}.token.value` },
        payload: { name },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_REQUEST',
      );
      const stored = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM organizations',
      );
      expect(stored.rows[0]?.count).toBe(0);
    },
  );

  it.each(rejectedNames)(
    'rejects rename with %s and preserves the stored Organization name',
    async (_reason, name) => {
      const organizationId = await seedOrganization();
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${ownerId}.token.value` },
        payload: { name },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_REQUEST',
      );
      const stored = await pool.query<{ name: string }>(
        'SELECT name FROM organizations WHERE id = $1',
        [organizationId],
      );
      expect(stored.rows).toEqual([{ name: 'Acme' }]);
    },
  );
});
