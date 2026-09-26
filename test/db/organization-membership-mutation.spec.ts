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
import { createPostgresIdentityClient } from '../../src/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from '../../src/modules/identity/infrastructure/postgres-organization-membership.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from './database';
import {
  PausingIdentityClient,
  waitForQueryCapture,
} from './pausing-identity-client';

const ORGANIZATION_ID = 'org_membership_mutation';
const REQUEST_ID = 'req_01J00000000000000000000000';
const NOW = new Date('2026-09-24T12:00:00.000Z');

const ROUTE_DENIAL = {
  change_role: 'Organization membership role change is forbidden',
  disable: 'Organization membership disable is forbidden',
  transfer: 'Organization ownership transfer is forbidden',
} as const;

const TARGET_REFUSAL = {
  change_role: 'Organization admins can only manage members',
  disable: 'Organization admins can only manage members',
  transfer: 'Ownership can only be transferred to a non-owner member',
} as const;

/** One text for every not-found, so a target's absence never explains itself. */
const NOT_FOUND = 'Resource not found';

type MutationRoute = keyof typeof ROUTE_DENIAL;

let app: NestFastifyApplication;
let pool: Pool;
let identityClient: PausingIdentityClient;
let ownerId: string;
let secondOwnerId: string;
let adminId: string;
let secondAdminId: string;
let memberId: string;

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
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_members (
       organization_id, user_account_id, role, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5)`,
    [ORGANIZATION_ID, userAccountId, role, status, NOW],
  );
}

function mutate(
  route: MutationRoute,
  callerId: string,
  username: string,
  requestedRole: 'admin' | 'member' = 'member',
) {
  const path = `/v1/organizations/${ORGANIZATION_ID}/members/${username}`;
  return app.inject({
    method:
      route === 'disable' ? 'DELETE' : route === 'transfer' ? 'POST' : 'PATCH',
    url: route === 'transfer' ? `${path}/transfer` : path,
    headers: { authorization: bearer(callerId) },
    ...(route === 'change_role' ? { payload: { role: requestedRole } } : {}),
  });
}

interface AuditRow {
  readonly action: string;
  readonly outcome: 'applied' | 'denied';
  readonly target_label: string | null;
  readonly detail: Record<string, unknown> | null;
}

async function auditEvents(): Promise<readonly AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT action, outcome, target_label, detail
     FROM organization_audit_events
     ORDER BY occurred_at, id`,
  );
  return result.rows;
}

function activeOwners(): Promise<number> {
  return pool
    .query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM organization_members
       WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
      [ORGANIZATION_ID],
    )
    .then((result) => result.rows[0]?.count ?? 0);
}

/**
 * The backend currently sitting in an open transaction.
 *
 * While the first mutation is held, it is the only one inside a transaction, and
 * it is the one holding the Organization row lock. Resolving the holder and
 * handing it to the lane's own `waitForBlockedBy` is what proves the second
 * request is blocked *by that backend*, rather than by anything else that might
 * have been slow.
 */
async function heldTransactionBackend(): Promise<number> {
  const result = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE datname = current_database()
       AND state = 'idle in transaction'
     LIMIT 1`,
  );
  const pid = result.rows[0]?.pid;
  if (pid === undefined) {
    throw new Error('no backend is holding a transaction open');
  }
  return pid;
}

interface Case {
  readonly name: string;
  readonly arrange?: () => Promise<void>;
  readonly callerId: () => string;
  readonly target: string;
  readonly requestedRole?: 'admin' | 'member';
  readonly status: number;
  readonly audit: number;
  readonly code?: string;
  readonly message?: string;
}

async function seedDisabledMember(username: string): Promise<void> {
  const id = await seedAccount(username);
  await seedMembership(id, 'member', 'disabled');
}

/**
 * The refusal matrix, written by hand rather than generated from the policy
 * functions, so a case built out of the thing it checks would prove nothing.
 *
 * `audit` is the number of Organization Audit Events the request leaves behind.
 * A real target and an invented one get the same response and not the same
 * record, which is only visible if a test says so.
 */
const CASES: Readonly<Record<MutationRoute, readonly Case[]>> = {
  change_role: [
    {
      name: 'an owner demoting an admin',
      callerId: () => ownerId,
      target: 'admin',
      status: 200,
      audit: 1,
    },
    {
      name: 'an owner demoting another owner while a second owner remains',
      callerId: () => ownerId,
      target: 'second-owner',
      status: 200,
      audit: 1,
    },
    {
      // The requested role is the one the membership already carries, so this
      // is a delivery rather than an act and writes nothing.
      name: 'an owner asking a member to become a member again',
      callerId: () => ownerId,
      target: 'member',
      status: 200,
      audit: 0,
    },
    {
      name: 'an admin promoting a member to admin',
      callerId: () => adminId,
      target: 'member',
      requestedRole: 'admin',
      status: 200,
      audit: 1,
    },
    {
      name: 'an admin changing an owner',
      callerId: () => adminId,
      target: 'owner',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.change_role,
    },
    {
      name: 'an admin changing another admin',
      callerId: () => adminId,
      target: 'second-admin',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.change_role,
    },
    {
      name: 'a member changing an owner',
      callerId: () => memberId,
      target: 'owner',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.change_role,
    },
    {
      name: 'a member changing a member',
      callerId: () => memberId,
      target: 'member',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.change_role,
    },
    {
      name: 'an owner changing a disabled member',
      callerId: () => ownerId,
      target: 'gone',
      status: 404,
      audit: 0,
      code: 'NOT_FOUND',
      message: NOT_FOUND,
      arrange: seedDisabledMember.bind(null, 'gone'),
    },
    {
      name: 'an admin changing a username that does not exist',
      callerId: () => adminId,
      target: 'nobody',
      status: 404,
      audit: 0,
      code: 'NOT_FOUND',
      message: NOT_FOUND,
    },
    {
      name: 'a member changing a username that does not exist',
      callerId: () => memberId,
      target: 'nobody',
      status: 403,
      audit: 0,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.change_role,
    },
  ],
  disable: [
    {
      name: 'an owner disabling a member',
      callerId: () => ownerId,
      target: 'member',
      status: 200,
      audit: 1,
    },
    {
      name: 'an admin disabling a member',
      callerId: () => adminId,
      target: 'member',
      status: 200,
      audit: 1,
    },
    {
      name: 'an owner disabling an admin',
      callerId: () => ownerId,
      target: 'admin',
      status: 200,
      audit: 1,
    },
    {
      name: 'an owner disabling another owner while a second owner remains',
      callerId: () => ownerId,
      target: 'second-owner',
      status: 200,
      audit: 1,
    },
    {
      name: 'an admin disabling an owner',
      callerId: () => adminId,
      target: 'owner',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.disable,
    },
    {
      name: 'an admin disabling another admin',
      callerId: () => adminId,
      target: 'second-admin',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.disable,
    },
    {
      name: 'a member disabling itself',
      callerId: () => memberId,
      target: 'member',
      status: 200,
      audit: 1,
    },
    {
      name: 'a member disabling an admin',
      callerId: () => memberId,
      target: 'admin',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.disable,
    },
    {
      name: 'an admin disabling a username that does not exist',
      callerId: () => adminId,
      target: 'nobody',
      status: 404,
      audit: 0,
      code: 'NOT_FOUND',
      message: NOT_FOUND,
    },
    {
      name: 'a member disabling a username that does not exist',
      callerId: () => memberId,
      target: 'nobody',
      status: 403,
      audit: 0,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.disable,
    },
  ],
  transfer: [
    {
      name: 'an owner transferring to a member',
      callerId: () => ownerId,
      target: 'member',
      status: 200,
      audit: 1,
    },
    {
      name: 'an owner transferring to an admin',
      callerId: () => ownerId,
      target: 'admin',
      status: 200,
      audit: 1,
    },
    {
      name: 'an owner transferring to another owner',
      callerId: () => ownerId,
      target: 'second-owner',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.transfer,
    },
    {
      name: 'an owner transferring to itself',
      callerId: () => ownerId,
      target: 'owner',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: TARGET_REFUSAL.transfer,
    },
    {
      name: 'an owner transferring to a disabled member',
      callerId: () => ownerId,
      target: 'gone',
      status: 404,
      audit: 0,
      code: 'NOT_FOUND',
      message: NOT_FOUND,
      arrange: seedDisabledMember.bind(null, 'gone'),
    },
    {
      name: 'an admin transferring to a member',
      callerId: () => adminId,
      target: 'member',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.transfer,
    },
    {
      name: 'a member transferring to a member',
      callerId: () => memberId,
      target: 'member',
      status: 403,
      audit: 1,
      code: 'FORBIDDEN',
      message: ROUTE_DENIAL.transfer,
    },
    {
      name: 'an owner transferring to a username that does not exist',
      callerId: () => ownerId,
      target: 'nobody',
      status: 404,
      audit: 0,
      code: 'NOT_FOUND',
      message: NOT_FOUND,
    },
  ],
};

beforeAll(async () => {
  pool = createTestPool();
  identityClient = new PausingIdentityClient(
    createPostgresIdentityClient(testDatabaseUrl()),
  );
  // The real repository over a real engine. ORGANIZATION_MEMBERSHIP_MUTATION is
  // deliberately not overridden, so the composition root builds the real
  // ManageOrganizationMembership on top of it.
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
    [ORGANIZATION_ID, 'Membership Mutation', 'active'],
  );
  ownerId = await seedAccount('owner');
  secondOwnerId = await seedAccount('second-owner');
  adminId = await seedAccount('admin');
  secondAdminId = await seedAccount('second-admin');
  memberId = await seedAccount('member');
  await seedMembership(ownerId, 'owner', 'active');
  await seedMembership(secondOwnerId, 'owner', 'active');
  await seedMembership(adminId, 'admin', 'active');
  await seedMembership(secondAdminId, 'admin', 'active');
  await seedMembership(memberId, 'member', 'active');
});

describe('Membership mutation over HTTP and PostgreSQL', () => {
  describe.each(['change_role', 'disable', 'transfer'] as const)(
    '%s',
    (route) => {
      it.each(
        CASES[route].map((testCase) => [testCase.name, testCase] as const),
      )('answers %s', async (_name, testCase) => {
        if (testCase.arrange !== undefined) {
          await testCase.arrange();
        }

        const response = await mutate(
          route,
          testCase.callerId(),
          testCase.target,
          testCase.requestedRole ?? 'member',
        );

        expect({
          status: response.statusCode,
          code: response.json().error?.code,
          message: response.json().error?.message,
          audit: (await auditEvents()).length,
        }).toEqual({
          status: testCase.status,
          code: testCase.code,
          message: testCase.message,
          audit: testCase.audit,
        });
      });

      it('gives a caller with no active membership the route denial, and records nothing', async () => {
        const outsiderId = await seedAccount('outsider');
        await pool.query(
          'DELETE FROM organization_members WHERE user_account_id = $1',
          [outsiderId],
        );

        const response = await mutate(route, outsiderId, 'member');

        expect({
          status: response.statusCode,
          code: response.json().error?.code,
          message: response.json().error?.message,
          audit: (await auditEvents()).length,
        }).toEqual({
          status: 403,
          code: 'FORBIDDEN',
          message: ROUTE_DENIAL[route],
          audit: 0,
        });
      });

      it('refuses a suspended Organization, and records nothing', async () => {
        await pool.query(
          "UPDATE organizations SET status = 'suspended' WHERE id = $1",
          [ORGANIZATION_ID],
        );

        const response = await mutate(route, ownerId, 'member');

        expect({
          status: response.statusCode,
          message: response.json().error?.message,
          audit: (await auditEvents()).length,
        }).toEqual({
          status: 403,
          message: ROUTE_DENIAL[route],
          audit: 0,
        });
      });
    },
  );

  it('answers a caller with no route authority identically for a real username and an invented one', async () => {
    const real = await mutate('change_role', memberId, 'owner');
    const invented = await mutate('change_role', memberId, 'nobody');

    const shape = (response: { statusCode: number; json: () => unknown }) => ({
      status: response.statusCode,
      body: response.json(),
    });

    expect(shape(real)).toEqual(shape(invented));
  });

  it('writes one applied event for a transfer, not two role changes', async () => {
    const response = await mutate('transfer', ownerId, 'member');

    expect(response.statusCode).toBe(200);
    expect(await auditEvents()).toEqual([
      {
        action: 'membership.owner_transferred',
        outcome: 'applied',
        target_label: 'member',
        detail: {
          fromRole: 'member',
          toRole: 'owner',
          previousOwnerUsername: 'owner',
          previousOwnerRole: 'admin',
        },
      },
    ]);
  });

  it('succeeds without a record when the requested state already holds', async () => {
    const disabledId = await seedAccount('already-disabled');
    await seedMembership(disabledId, 'member', 'disabled');

    const disableResponse = await mutate(
      'disable',
      ownerId,
      'already-disabled',
    );
    const roleResponse = await mutate('change_role', ownerId, 'member');

    expect({
      disable: disableResponse.statusCode,
      role: roleResponse.statusCode,
      audit: (await auditEvents()).length,
    }).toEqual({ disable: 200, role: 200, audit: 0 });
  });

  it('records the refusal reason for a caller whose route authority is missing but whose target is real', async () => {
    await mutate('change_role', memberId, 'owner');

    expect(await auditEvents()).toEqual([
      {
        action: 'membership.role_changed',
        outcome: 'denied',
        target_label: 'owner',
        detail: {
          fromRole: 'owner',
          requestedRole: 'member',
          denial: 'insufficient_authority',
        },
      },
    ]);
  });

  it('refuses to take the last active owner out of the Organization, by disable and by demotion alike', async () => {
    for (const id of [secondOwnerId, adminId, secondAdminId, memberId]) {
      await pool.query(
        'DELETE FROM organization_members WHERE user_account_id = $1',
        [id],
      );
    }

    const disableResponse = await mutate('disable', ownerId, 'owner');
    const disableAudit = await auditEvents();
    await pool.query('TRUNCATE TABLE organization_audit_events');
    const demoteResponse = await mutate('change_role', ownerId, 'owner');

    expect({
      disable: {
        status: disableResponse.statusCode,
        code: disableResponse.json().error?.code,
        denial: disableAudit.map((event) => event.detail?.['denial']),
      },
      demote: {
        status: demoteResponse.statusCode,
        code: demoteResponse.json().error?.code,
        denial: (await auditEvents()).map((event) => event.detail?.['denial']),
      },
      owners: await activeOwners(),
    }).toEqual({
      disable: {
        status: 409,
        code: 'ORGANIZATION_OWNER_REQUIRED',
        denial: ['owner_required'],
      },
      demote: {
        status: 409,
        code: 'ORGANIZATION_OWNER_REQUIRED',
        denial: ['owner_required'],
      },
      owners: 1,
    });
  });

  it('keeps an owner when two owners demote each other at the same moment', async () => {
    // Held straight after the Organization row lock is taken, so the second
    // request can only be waiting on that lock and on nothing else.
    const pause = identityClient.pauseAfterQueryContaining('FOR UPDATE');
    const first = mutate('change_role', ownerId, 'second-owner');
    try {
      await waitForQueryCapture(pause, 10_000);

      const holder = await heldTransactionBackend();
      const second = mutate('change_role', secondOwnerId, 'owner');
      const waiting = await waitForBlockedBy(pool, holder);

      pause.release();
      const responses = await Promise.all([first, second]);

      expect({
        secondWasBlockedByTheHolder: waiting > 0,
        succeeded: responses.filter((r) => r.statusCode === 200).length,
        owners: await activeOwners(),
      }).toEqual({
        secondWasBlockedByTheHolder: true,
        succeeded: 1,
        owners: 1,
      });
    } finally {
      // A hold that outlives its test would stall every later statement and the
      // suite's own teardown.
      identityClient.disarm();
      pause.release();
      await first.catch(() => undefined);
    }
  });
});
