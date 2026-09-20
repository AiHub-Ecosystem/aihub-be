import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { AppError } from '../../../common/errors/app-error';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../../auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationRosterOrganization,
} from '../application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';

const roster: readonly OrganizationRosterOrganization[] = [
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
];

describe('Organization membership HTTP flow', () => {
  let app: NestFastifyApplication;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let accountStatus: 'active' | 'disabled' = 'active';
  let verifier: UserAccessTokenVerifierPort;

  beforeAll(async () => {
    membership = {
      resolveMembership: jest.fn(),
      listRoster: jest.fn(async (_input: ListRosterInput) => roster),
    };
    verifier = {
      verify: async (token: string) => {
        if (token !== 'valid.token.value') {
          throw new Error('invalid token');
        }
        return { userId: USER_ID, jti: 'jti_01' };
      },
    };

    const localAuthRepository: Pick<
      LocalAuthRepositoryPort,
      'findUserAccountStatus'
    > = {
      findUserAccountStatus: async () => accountStatus,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(LOCAL_AUTH_REPOSITORY)
      .useValue(localAuthRepository)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => 'req_01J00000000000000000000000' }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    accountStatus = 'active';
    membership.listRoster.mockResolvedValue(roster);
    jest.clearAllMocks();
  });

  function rosterRequest(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
  ) {
    return app.inject({
      method: 'GET',
      url: '/v1/organizations/me/members',
      headers,
    });
  }

  it('returns the redacted grouped roster through the Bearer boundary', async () => {
    const response = await rosterRequest();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        organizations: [
          {
            organization_id: 'org_acme',
            name: 'Acme',
            status: 'active',
            membership: { role: 'owner' },
            members: [
              { username: 'alice', role: 'owner' },
              { username: 'bob', role: 'member' },
            ],
          },
          {
            organization_id: 'org_suspended',
            name: 'Suspended',
            status: 'suspended',
            membership: { role: 'member' },
            members: [{ username: 'alice', role: 'member' }],
          },
        ],
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    });
    expect(response.payload).not.toContain(USER_ID);
    expect(response.payload).not.toContain('@');
    expect(membership.listRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        context: expect.objectContaining({ userId: USER_ID }),
      }),
    );
  });

  it('returns an empty roster for an authenticated account without memberships', async () => {
    membership.listRoster.mockResolvedValue([]);

    const response = await rosterRequest();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { organizations: [] },
      meta: { request_id: 'req_01J00000000000000000000000' },
    });
  });

  it('requires the User Access JWT and emits the Bearer challenge', async () => {
    const response = await rosterRequest({});

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(membership.listRoster).not.toHaveBeenCalled();
  });

  it('fails closed when the membership store is unavailable', async () => {
    membership.listRoster.mockRejectedValue(
      new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Identity store is unavailable',
        retryable: false,
      }),
    );

    const response = await rosterRequest();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(response.payload).not.toContain('Acme');
  });

  it('rejects a disabled User Account before reading memberships', async () => {
    accountStatus = 'disabled';

    const response = await rosterRequest();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' },
    });
    expect(membership.listRoster).not.toHaveBeenCalled();
  });
});
