import { ulid } from 'ulid';

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';

import { AppModule } from '../../src/app.module';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../../src/modules/auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '../../src/modules/auth/application/user-access-token.port';
import { ORGANIZATION_MEMBERSHIP } from '../../src/modules/identity/application/organization-membership.port';
import {
  type PostgresIdentityQueryClient,
  type PostgresIdentityTransactionalClient,
  createPostgresIdentityClient,
} from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from '../../src/modules/identity/infrastructure/postgres-organization-membership.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const ORGANIZATION_ID = 'org_membership_list';
const REQUEST_ID = 'req_01J00000000000000000000000';
const NOW = new Date('2026-09-24T12:00:00.000Z');

let app: NestFastifyApplication;
let pool: Pool;
let ownerId: string;

interface QueryPause {
  readonly captured: Promise<void>;
  release(): void;
}

class PausingIdentityClient
  implements PostgresIdentityQueryClient, PostgresIdentityTransactionalClient
{
  private pause:
    | {
        readonly captured: () => void;
        readonly released: Promise<void>;
        release(): void;
      }
    | undefined;

  constructor(
    private readonly client: ReturnType<typeof createPostgresIdentityClient>,
  ) {}

  pauseAfterNextQuery(): QueryPause {
    let markCaptured!: () => void;
    let release!: () => void;
    const captured = new Promise<void>((resolve) => {
      markCaptured = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { captured: markCaptured, released, release };
    return { captured, release };
  }

  async query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> {
    const rows = await this.client.query(text, values);
    const pause = this.pause;
    if (pause !== undefined) {
      this.pause = undefined;
      pause.captured();
      await pause.released;
    }
    return rows;
  }

  transaction<T>(
    callback: Parameters<PostgresIdentityTransactionalClient['transaction']>[0],
  ): Promise<T> {
    return this.client.transaction(callback) as Promise<T>;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

let identityClient: PausingIdentityClient;

function bearer(userId: string): string {
  return `Bearer ${userId}.token.value`;
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
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'disabled',
  organizationId = ORGANIZATION_ID,
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [organizationId, userAccountId, role, status, NOW],
  );
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

async function waitForQueryCapture(pause: QueryPause): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pause.captured,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('membership list query did not finish')),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

beforeAll(async () => {
  pool = createTestPool();
  identityClient = new PausingIdentityClient(
    createPostgresIdentityClient(testDatabaseUrl()),
  );
  const membership = new PostgresOrganizationMembershipRepository(
    identityClient,
  );
  const verifier: UserAccessTokenVerifierPort = {
    verify: async (token) => ({
      userId: token.split('.')[0] ?? '',
      jti: 'jti_01',
    }),
  };
  const localAuthRepository: Pick<
    LocalAuthRepositoryPort,
    'findUserAccountStatus'
  > = {
    findUserAccountStatus: async (userId) => {
      const result = await pool.query<{ status: 'active' | 'disabled' }>(
        'SELECT status FROM user_accounts WHERE id = $1',
        [userId],
      );
      return result.rows[0]?.status;
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ORGANIZATION_MEMBERSHIP)
    .useValue(membership)
    .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
    .useValue(verifier)
    .overrideProvider(LOCAL_AUTH_REPOSITORY)
    .useValue(localAuthRepository)
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
    [ORGANIZATION_ID, 'Membership List', 'active'],
  );
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
      data: { members: [] },
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
      expect({ status: response.statusCode, body: response.json() }).toEqual(
        denial,
      );
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

      pause = identityClient.pauseAfterNextQuery();
      request = listMemberships(ownerId);
      await waitForQueryCapture(pause);

      await holder.query('COMMIT');
      transactionOpen = false;
      pause.release();

      const snapshotResponse = await request;
      expect(snapshotResponse.statusCode).toBe(200);
      expect(snapshotResponse.json().data.members).toContainEqual({
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
});
