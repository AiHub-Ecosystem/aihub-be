import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';
import { AppError } from '../../../common/errors/app-error';
import { ORGANIZATION_ROSTER_PATH } from '../../../contracts/organization/membership';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../../auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import {
  ORGANIZATION_MEMBERSHIP_MUTATION,
  type OrganizationMembershipMutationPort,
} from '../application/organization-membership-mutation.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationRosterOrganization,
} from '../application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const MUTATION_URL = `/v1/organizations/${ORGANIZATION_ID}/members/bob`;

const roster: readonly OrganizationRosterOrganization[] = [
  {
    organizationId: 'org_acme',
    name: 'Acme',
    status: 'active',
    entitlements: ['writing'],
    identityConfigured: true,
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
    entitlements: ['writing', 'speaking'],
    identityConfigured: false,
    membershipRole: 'member',
    members: [{ username: 'alice', role: 'member' }],
  },
];

describe('Organization membership HTTP flow', () => {
  let app: NestFastifyApplication;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let mutation: jest.Mocked<OrganizationMembershipMutationPort>;
  let accountStatus: 'active' | 'disabled' = 'active';
  let verifier: UserAccessTokenVerifierPort;

  beforeAll(async () => {
    membership = {
      resolveMembership: jest.fn(),
      listRoster: jest.fn(async (_input: ListRosterInput) => roster),
      changeRole: jest.fn(),
      disable: jest.fn(),
      transfer: jest.fn(),
    };
    mutation = {
      changeRole: jest.fn(async (input) => ({
        organizationId: input.organizationId,
        username: input.username,
        role: input.role,
        status: 'active' as const,
      })),
      disable: jest.fn(async (input) => ({
        organizationId: input.organizationId,
        username: input.username,
        role: 'member' as const,
        status: 'disabled' as const,
      })),
      transfer: jest.fn(async (input) => ({
        organizationId: input.organizationId,
        username: input.username,
        role: 'owner' as const,
        status: 'active' as const,
      })),
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
      .overrideProvider(ORGANIZATION_MEMBERSHIP_MUTATION)
      .useValue(mutation)
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
    mutation.changeRole.mockClear();
    mutation.disable.mockClear();
    mutation.transfer.mockClear();
    jest.clearAllMocks();
  });

  function rosterRequest(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = ORGANIZATION_ROSTER_PATH,
  ) {
    return app.inject({
      method: 'GET',
      url,
      headers,
    });
  }

  function mutationRequest(
    method: 'PATCH' | 'DELETE' | 'POST',
    url = MUTATION_URL,
    payload?: object,
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
  ) {
    return app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
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
            entitlements: ['writing'],
            identity_configured: true,
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
            entitlements: ['writing', 'speaking'],
            identity_configured: false,
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

  it('allows an admin to read the same redacted roster shape', async () => {
    membership.listRoster.mockResolvedValue([
      {
        organizationId: 'org_admin',
        name: 'Admin Org',
        status: 'active',
        entitlements: ['writing'],
        identityConfigured: true,
        membershipRole: 'admin',
        members: [
          { username: 'alice', role: 'owner' },
          { username: 'carol', role: 'admin' },
        ],
      },
    ]);

    const response = await rosterRequest();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        organizations: [
          {
            organization_id: 'org_admin',
            entitlements: ['writing'],
            identity_configured: true,
            membership: { role: 'admin' },
            members: [
              { username: 'alice', role: 'owner' },
              { username: 'carol', role: 'admin' },
            ],
          },
        ],
      },
    });
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

  it('rejects a malformed Bearer token before reading memberships', async () => {
    const response = await rosterRequest({
      authorization: 'Bearer malformed-token',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(membership.listRoster).not.toHaveBeenCalled();
  });

  it('rejects alternate query token sources even with a valid Bearer token', async () => {
    const response = await rosterRequest(
      { authorization: 'Bearer valid.token.value' },
      `${ORGANIZATION_ROSTER_PATH}?access_token=alternate`,
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(membership.listRoster).not.toHaveBeenCalled();
  });

  it('ignores client-supplied tenant and user selectors', async () => {
    const response = await rosterRequest(
      { authorization: 'Bearer valid.token.value' },
      `${ORGANIZATION_ROSTER_PATH}?organization_id=org_other&user_id=usr_other`,
    );

    expect(response.statusCode).toBe(200);
    expect(membership.listRoster).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
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

  it('rejects a disabled User Account before membership mutation', async () => {
    accountStatus = 'disabled';

    const response = await mutationRequest('DELETE');

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTH_USER_ACCESS_TOKEN_INVALID' },
    });
    expect(mutation.disable).not.toHaveBeenCalled();
  });

  it('changes a member role through the Bearer management boundary', async () => {
    const response = await mutationRequest('PATCH', MUTATION_URL, {
      role: 'admin',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        organization_id: ORGANIZATION_ID,
        username: 'bob',
        role: 'admin',
        status: 'active',
      },
      meta: { request_id: 'req_01J00000000000000000000000' },
    });
    expect(mutation.changeRole).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        username: 'bob',
        role: 'admin',
        context: expect.objectContaining({ organizationId: ORGANIZATION_ID }),
      }),
    );
  });

  it('disables a member through DELETE and returns the durable state', async () => {
    const response = await mutationRequest('DELETE');

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      organization_id: ORGANIZATION_ID,
      username: 'bob',
      role: 'member',
      status: 'disabled',
    });
    expect(mutation.disable).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        username: 'bob',
      }),
    );
  });

  it('transfers ownership through the dedicated command without a request body', async () => {
    const response = await mutationRequest('POST', `${MUTATION_URL}/transfer`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      organization_id: ORGANIZATION_ID,
      username: 'bob',
      role: 'owner',
      status: 'active',
    });
    expect(mutation.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        username: 'bob',
      }),
    );
  });

  it.each([
    ['missing role', {}],
    ['owner promotion', { role: 'owner' }],
    ['unexpected field', { role: 'admin', status: 'active' }],
  ])('rejects %s before calling the mutation port', async (_label, payload) => {
    const response = await mutationRequest('PATCH', MUTATION_URL, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(mutation.changeRole).not.toHaveBeenCalled();
  });

  it('rejects a transfer request body before calling the mutation port', async () => {
    const response = await mutationRequest('POST', `${MUTATION_URL}/transfer`, {
      role: 'owner',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(mutation.transfer).not.toHaveBeenCalled();
  });

  it('requires Bearer authentication before reaching membership mutations', async () => {
    const response = await mutationRequest(
      'DELETE',
      MUTATION_URL,
      undefined,
      {},
    );

    expect(response.statusCode).toBe(401);
    expect(mutation.disable).not.toHaveBeenCalled();
  });
});
