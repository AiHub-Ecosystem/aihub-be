import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import type { OrganizationMembershipMutationAction } from '@/modules/identity/application/organization-membership.mutation-policy';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
} from '@/modules/identity/application/organization-membership.port';
import type {
  PostgresIdentityClient,
  PostgresIdentityTransactionalClient,
} from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationMembershipRepository } from '@/modules/identity/infrastructure/postgres-organization-membership.repository';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const MUTATION_URL = `/v1/organizations/${ORGANIZATION_ID}/members/bob`;

const callerOwnerRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: USER_ID,
  username: 'alice',
  role: 'owner',
  membership_status: 'active',
};

const targetMemberRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'member',
  membership_status: 'active',
};

const targetAdminResultRow = {
  organization_id: ORGANIZATION_ID,
  user_account_id: 'usr_bob',
  username: 'bob',
  role: 'admin',
  membership_status: 'active',
};

const REQUEST_ID = 'req_01J00000000000000000000000';

type Role = OrganizationMembershipRole;

function membershipRow(
  userId: string,
  username: string,
  role: Role,
  status: 'active' | 'disabled' = 'active',
) {
  return {
    organization_id: ORGANIZATION_ID,
    user_account_id: userId,
    username,
    role,
    membership_status: status,
  };
}

function resolvedCaller(
  role: Role,
  status: 'active' | 'disabled' = 'active',
  organizationStatus: 'active' | 'suspended' = 'active',
) {
  return {
    organization_id: ORGANIZATION_ID,
    user_account_id: USER_ID,
    organization_status: organizationStatus,
    role,
    membership_status: status,
  };
}

class FakePostgres
  implements PostgresIdentityClient, PostgresIdentityTransactionalClient
{
  readonly queries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];

  readonly transactionQueries: Array<{
    readonly text: string;
    readonly values: readonly unknown[];
  }> = [];

  // What membership resolution sees before any transaction opens.
  result: readonly unknown[] = [resolvedCaller('owner')];

  // Rows each successive query inside the transaction returns: the locked
  // Organization, the locked caller and target memberships, then the write.
  transactionRows: readonly (readonly unknown[])[] = [
    [{ id: ORGANIZATION_ID, status: 'active' }],
    [callerOwnerRow, targetMemberRow],
    [targetAdminResultRow],
  ];

  reset(): void {
    this.queries.length = 0;
    this.transactionQueries.length = 0;
    this.result = [resolvedCaller('owner')];
    this.transactionRows = [
      [{ id: ORGANIZATION_ID, status: 'active' }],
      [callerOwnerRow, targetMemberRow],
      [targetAdminResultRow],
    ];
  }

  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]> {
    this.queries.push({ text, values });
    return Promise.resolve(
      text.includes('INSERT INTO organization_audit_events') ? [] : this.result,
    );
  }

  transaction<T>(
    callback: Parameters<PostgresIdentityTransactionalClient['transaction']>[0],
  ): Promise<T> {
    let index = 0;
    return callback({
      query: async (text, values) => {
        this.transactionQueries.push({ text, values });
        return this.transactionRows[index++] ?? [];
      },
    }) as Promise<T>;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  // A denial is written after the transaction rolls back, outside it.
  deniedAuditWrites(): readonly unknown[][] {
    return this.queries
      .filter((query) =>
        query.text.includes('INSERT INTO organization_audit_events'),
      )
      .map((query) => [...query.values]);
  }
}

describe('Organization membership HTTP/application/repository integration', () => {
  let app: NestFastifyApplication;
  let client: FakePostgres;

  beforeAll(async () => {
    client = new FakePostgres();
    const membership: OrganizationMembershipPort =
      new PostgresOrganizationMembershipRepository(client);
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };
    const userAccounts = userAccountStatus();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
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
  });

  beforeEach(() => {
    client.reset();
  });

  it('wires a Bearer role mutation through the application and repository ports', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: MUTATION_URL,
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { role: 'admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        organization_id: ORGANIZATION_ID,
        username: 'bob',
        role: 'admin',
        status: 'active',
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(client.transactionQueries[0]?.text).toContain('FROM organizations');
    expect(client.transactionQueries[0]?.text).toContain('FOR UPDATE');
    expect(client.transactionQueries[1]?.text).toContain(
      'FOR UPDATE OF membership',
    );
    expect(client.transactionQueries.at(-2)?.text).toContain(
      'UPDATE organization_members',
    );
    expect(client.transactionQueries.at(-1)?.text).toContain(
      'INSERT INTO organization_audit_events',
    );
  });

  type Route = OrganizationMembershipMutationAction;

  function mutate(route: Route, username = 'bob') {
    const url = `/v1/organizations/${ORGANIZATION_ID}/members/${username}`;
    const headers = { authorization: 'Bearer valid.token.value' };
    if (route === 'change_role') {
      return app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { role: 'admin' },
      });
    }
    if (route === 'disable') {
      return app.inject({ method: 'DELETE', url, headers });
    }
    return app.inject({ method: 'POST', url: `${url}/transfer`, headers });
  }

  function refusal(message: string) {
    return {
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message,
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    };
  }

  const activeOrganization = [{ id: ORGANIZATION_ID, status: 'active' }];

  // The role on each route that holds no authority over another membership.
  const unauthorizedRole: Record<Route, Role> = {
    change_role: 'member',
    disable: 'member',
    transfer: 'admin',
  };

  const routeDenial: Record<Route, string> = {
    change_role: 'Organization membership role change is forbidden',
    disable: 'Organization membership disable is forbidden',
    transfer: 'Organization ownership transfer is forbidden',
  };

  describe.each<Route>(['change_role', 'disable', 'transfer'])(
    'every caller outside the %s route authority',
    (route) => {
      const role = unauthorizedRole[route];
      const caller = membershipRow(USER_ID, 'alice', role);

      // Refused before the target is looked up, so the same whether the
      // named username exists or not.
      const beforeTarget: ReadonlyArray<[string, () => void]> = [
        [
          'no membership in the organization',
          () => {
            client.result = [];
          },
        ],
        [
          'a disabled membership',
          () => {
            client.result = [resolvedCaller('owner', 'disabled')];
          },
        ],
        [
          'an owner of a suspended organization',
          () => {
            client.result = [resolvedCaller('owner', 'active', 'suspended')];
          },
        ],
        [
          'an owner whose organization is suspended inside the transaction',
          () => {
            client.transactionRows = [
              [{ id: ORGANIZATION_ID, status: 'suspended' }],
            ];
          },
        ],
      ];

      // One literal per route: each case equals it, so no two refusals can
      // differ by status, code, or message. A real member refused on a real
      // target leaves a recorded denial exactly when the target-level policy
      // refused it before route authority existed.
      it.each<[string, () => void, string, number]>([
        ...beforeTarget.flatMap(
          ([label, arrange]): Array<[string, () => void, string, number]> => [
            [`${label}, naming a real membership`, arrange, 'bob', 0],
            [`${label}, naming an unknown username`, arrange, 'nobody', 0],
          ],
        ),
        [
          'an owner whose membership is disabled inside the transaction',
          () => {
            client.transactionRows = [
              activeOrganization,
              [membershipRow(USER_ID, 'alice', 'owner', 'disabled')],
            ];
          },
          'bob',
          0,
        ],
        [
          `a ${role} naming a real membership`,
          () => {
            client.result = [resolvedCaller(role)];
            client.transactionRows = [
              activeOrganization,
              [caller, targetMemberRow],
            ];
          },
          'bob',
          1,
        ],
        [
          `a ${role} naming a disabled membership`,
          () => {
            client.result = [resolvedCaller(role)];
            client.transactionRows = [
              activeOrganization,
              [caller, membershipRow('usr_bob', 'bob', 'member', 'disabled')],
            ];
          },
          'bob',
          // Only disable ever refused a disabled target on authority; the
          // other routes answered not-found and recorded nothing.
          route === 'disable' ? 1 : 0,
        ],
        [
          `a ${role} naming a username that does not exist`,
          () => {
            client.result = [resolvedCaller(role)];
            client.transactionRows = [activeOrganization, [caller]];
          },
          'nobody',
          0,
        ],
      ])(
        'gives %s the same denial',
        async (_label, arrange, username, recorded) => {
          arrange();

          const response = await mutate(route, username);

          expect({
            status: response.statusCode,
            body: response.json(),
          }).toEqual(refusal(routeDenial[route]));
          expect(client.deniedAuditWrites()).toHaveLength(recorded);
        },
      );
    },
  );

  it.each<[Route, Role]>([
    ['change_role', 'admin'],
    ['change_role', 'owner'],
    ['disable', 'admin'],
    ['disable', 'owner'],
  ])(
    'tells an admin who tries %s on a %s that admins only manage members',
    async (route, targetRole) => {
      client.result = [resolvedCaller('admin')];
      client.transactionRows = [
        activeOrganization,
        [
          membershipRow(USER_ID, 'alice', 'admin'),
          membershipRow('usr_bob', 'bob', targetRole),
        ],
      ];

      const response = await mutate(route);

      expect({ status: response.statusCode, body: response.json() }).toEqual(
        refusal('Organization admins can only manage members'),
      );
      expect(client.deniedAuditWrites()).toHaveLength(1);
    },
  );

  it.each<[string, string, readonly unknown[]]>([
    [
      'another owner',
      'bob',
      [callerOwnerRow, membershipRow('usr_bob', 'bob', 'owner')],
    ],
    ['themselves', 'alice', [callerOwnerRow]],
  ])(
    'tells an owner transferring to %s that ownership goes to a non-owner member',
    async (_label, username, locked) => {
      client.transactionRows = [activeOrganization, locked];

      const response = await mutate('transfer', username);

      expect({ status: response.statusCode, body: response.json() }).toEqual(
        refusal('Ownership can only be transferred to a non-owner member'),
      );
    },
  );

  it.each<[Route, Role]>([
    ['change_role', 'owner'],
    ['change_role', 'admin'],
    ['disable', 'owner'],
    ['disable', 'admin'],
    ['transfer', 'owner'],
  ])(
    'still reports an unknown target on %s to an authorized %s as not found',
    async (route, role) => {
      client.result = [resolvedCaller(role)];
      client.transactionRows = [
        activeOrganization,
        [membershipRow(USER_ID, 'alice', role)],
      ];

      const response = await mutate(route, 'nobody');

      expect(response.statusCode).toBe(404);
      expect(client.deniedAuditWrites()).toHaveLength(0);
    },
  );

  it('still lets a member disable their own membership', async () => {
    client.result = [resolvedCaller('member')];
    client.transactionRows = [
      activeOrganization,
      [membershipRow(USER_ID, 'alice', 'member')],
      [membershipRow(USER_ID, 'alice', 'member', 'disabled')],
    ];

    const response = await mutate('disable', 'alice');

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      username: 'alice',
      status: 'disabled',
    });
  });
});
