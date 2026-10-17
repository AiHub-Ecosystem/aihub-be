import { AppError } from '@/common/errors/app-error';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/accounts/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import {
  ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL,
  ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL,
  type OrganizationMembershipMutationAction,
  authorizeOrganizationMembershipMutation,
  hasOrganizationMembershipRouteAuthority,
} from '@/modules/identity/membership/application/organization-membership.mutation-policy';
import {
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipMutationInput,
  type OrganizationMembershipMutationResult,
  type OrganizationMembershipPort,
  type OrganizationMembershipRecord,
  type OrganizationMembershipResolution,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const MUTATION_URL = `/v1/organizations/${ORGANIZATION_ID}/members/bob`;
const REQUEST_ID = 'req_01J00000000000000000000000';

type Role = OrganizationMembershipRole;
type Status = OrganizationMembershipStatus;

interface LockedMember extends OrganizationMembershipRecord {
  readonly username: string;
}

function member(
  userId: string,
  username: string,
  role: Role,
  status: Status = 'active',
): LockedMember {
  return {
    organizationId: ORGANIZATION_ID,
    userId,
    username,
    organizationStatus: 'active',
    role,
    status,
  };
}

function activeResolution(
  role: Role,
  status: Status = 'active',
  organizationStatus: 'active' | 'suspended' = 'active',
): OrganizationMembershipResolution {
  const membership = {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    organizationStatus,
    role,
    status,
  };
  return status === 'active'
    ? { kind: 'active', membership }
    : { kind: 'disabled', membership };
}

function forbidden(message: string): AppError {
  return new AppError({ code: 'FORBIDDEN', message, retryable: false });
}

function notFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Resource not found',
    retryable: false,
  });
}

/** Models only the application-port outcomes needed by this HTTP suite. */
class MembershipPortFake implements OrganizationMembershipPort {
  resolution: OrganizationMembershipResolution = activeResolution('owner');
  organizationStatus: 'active' | 'suspended' = 'active';
  caller: LockedMember = member(USER_ID, 'alice', 'owner');
  targets = new Map<string, LockedMember>([
    ['bob', member('usr_bob', 'bob', 'member')],
  ]);

  reset(): void {
    this.resolution = activeResolution('owner');
    this.organizationStatus = 'active';
    this.caller = member(USER_ID, 'alice', 'owner');
    this.targets = new Map([['bob', member('usr_bob', 'bob', 'member')]]);
  }

  async resolveMembership(): Promise<OrganizationMembershipResolution> {
    return this.resolution;
  }

  async listRoster(): Promise<[]> {
    return [];
  }

  changeRole(
    input: OrganizationMembershipMutationInput & {
      readonly role: 'admin' | 'member';
    },
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate('change_role', input, input.role);
  }

  disable(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate('disable', input);
  }

  transfer(
    input: OrganizationMembershipMutationInput,
  ): Promise<OrganizationMembershipMutationResult> {
    return this.mutate('transfer', input);
  }

  private async mutate(
    action: OrganizationMembershipMutationAction,
    input: OrganizationMembershipMutationInput,
    requestedRole?: 'admin' | 'member',
  ): Promise<OrganizationMembershipMutationResult> {
    const denial = ORGANIZATION_MEMBERSHIP_ROUTE_DENIAL[action];
    if (
      this.organizationStatus !== 'active' ||
      this.caller.status !== 'active'
    ) {
      throw forbidden(denial);
    }

    const target =
      input.username === this.caller.username
        ? this.caller
        : this.targets.get(input.username);
    if (
      !hasOrganizationMembershipRouteAuthority({
        action,
        callerRole: this.caller.role,
        targetIsCaller: target?.userId === this.caller.userId,
      })
    ) {
      throw forbidden(denial);
    }
    if (target === undefined) {
      throw notFound();
    }

    const decision = authorizeOrganizationMembershipMutation({
      action,
      callerUserId: this.caller.userId,
      callerRole: this.caller.role,
      targetUserId: target.userId,
      targetRole: target.role,
      targetStatus: target.status,
    });
    if (decision.kind === 'forbidden') {
      throw forbidden(ORGANIZATION_MEMBERSHIP_TARGET_REFUSAL[action]);
    }
    if (decision.kind === 'target_unavailable') {
      throw notFound();
    }

    const role =
      action === 'change_role'
        ? requestedRole!
        : action === 'transfer'
          ? 'owner'
          : target.role;
    const status = action === 'disable' ? 'disabled' : target.status;
    if (action === 'transfer') {
      this.caller = { ...this.caller, role: 'admin' };
    }
    const updated = { ...target, role, status };
    if (input.username === this.caller.username && action !== 'transfer') {
      this.caller = updated;
    } else {
      this.targets.set(input.username, updated);
    }
    return {
      organizationId: ORGANIZATION_ID,
      username: updated.username,
      role: updated.role,
      status: updated.status,
    };
  }
}

describe('Organization membership HTTP/application integration', () => {
  let app: NestFastifyApplication;
  let membership: MembershipPortFake;

  beforeAll(async () => {
    membership = new MembershipPortFake();
    const verifier: UserAccessTokenVerifierPort = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCOUNT_REPOSITORY)
      .useValue(userAccountStatus())
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

  beforeEach(() => membership.reset());

  it('returns the membership mutation through the application port', async () => {
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
      const caller = member(USER_ID, 'alice', role);
      const beforeTarget: ReadonlyArray<[string, () => void]> = [
        [
          'no membership in the organization',
          () => {
            membership.resolution = { kind: 'missing' };
          },
        ],
        [
          'a disabled membership',
          () => {
            membership.resolution = activeResolution('owner', 'disabled');
          },
        ],
        [
          'an owner of a suspended organization',
          () => {
            membership.resolution = activeResolution(
              'owner',
              'active',
              'suspended',
            );
          },
        ],
        [
          'an owner whose organization is suspended inside the transaction',
          () => {
            membership.organizationStatus = 'suspended';
          },
        ],
      ];

      it.each<[string, () => void, string]>([
        ...beforeTarget.flatMap(([label, arrange]) => [
          [`${label}, naming a real membership`, arrange, 'bob'] as [
            string,
            () => void,
            string,
          ],
          [`${label}, naming an unknown username`, arrange, 'nobody'] as [
            string,
            () => void,
            string,
          ],
        ]),
        [
          "an owner's membership is disabled inside the transaction",
          () => {
            membership.resolution = activeResolution('owner');
            membership.caller = member(USER_ID, 'alice', 'owner', 'disabled');
          },
          'bob',
        ],
        [
          `a ${role} naming a real membership`,
          () => {
            membership.resolution = activeResolution(role);
            membership.caller = caller;
          },
          'bob',
        ],
        [
          `a ${role} naming a disabled membership`,
          () => {
            membership.resolution = activeResolution(role);
            membership.caller = caller;
            membership.targets.set(
              'bob',
              member('usr_bob', 'bob', 'member', 'disabled'),
            );
          },
          'bob',
        ],
        [
          `a ${role} naming a username that does not exist`,
          () => {
            membership.resolution = activeResolution(role);
            membership.caller = caller;
            membership.targets.clear();
          },
          'nobody',
        ],
      ])('gives %s the same denial', async (_label, arrange, username) => {
        arrange();

        const response = await mutate(route, username);

        expect({ status: response.statusCode, body: response.json() }).toEqual(
          refusal(routeDenial[route]),
        );
      });
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
      membership.resolution = activeResolution('admin');
      membership.caller = member(USER_ID, 'alice', 'admin');
      membership.targets.set('bob', member('usr_bob', 'bob', targetRole));

      const response = await mutate(route);

      expect({ status: response.statusCode, body: response.json() }).toEqual(
        refusal('Organization admins can only manage members'),
      );
    },
  );

  it.each<[string, string, LockedMember[]]>([
    [
      'another owner',
      'bob',
      [member(USER_ID, 'alice', 'owner'), member('usr_bob', 'bob', 'owner')],
    ],
    ['themselves', 'alice', [member(USER_ID, 'alice', 'owner')]],
  ])(
    'tells an owner transferring to %s that ownership goes to a non-owner member',
    async (_label, username, locked) => {
      membership.caller = locked[0]!;
      membership.targets.clear();
      if (locked[1] !== undefined)
        membership.targets.set(locked[1].username, locked[1]);

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
      membership.resolution = activeResolution(role);
      membership.caller = member(USER_ID, 'alice', role);
      membership.targets.clear();

      const response = await mutate(route, 'nobody');

      expect(response.statusCode).toBe(404);
    },
  );

  it('still lets a member disable their own membership', async () => {
    membership.resolution = activeResolution('member');
    membership.caller = member(USER_ID, 'alice', 'member');

    const response = await mutate('disable', 'alice');

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      username: 'alice',
      status: 'disabled',
    });
  });
});
