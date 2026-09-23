import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '../../../app.module';
import { ListOrganizationApiKeysResponseSchema } from '../../../contracts/organization/api-key';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../../auth/application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import {
  type ListOrganizationApiKeysInput,
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type OrganizationApiKeyRecord,
} from '../application/organization-api-key.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '../application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const KEYS_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys`;

type OrganizationStatus = 'active' | 'suspended';

function keyRecord(
  overrides: Partial<OrganizationApiKeyRecord> = {},
): OrganizationApiKeyRecord {
  return {
    apiKeyId: 'ak_01J00000000000000000000001',
    name: 'Prod backend',
    keyPrefix: 'aihub_sk_A1b2C3',
    scopes: ['writing.grade'],
    allowedEnvironments: ['production'],
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    ...overrides,
  };
}

describe('Organization API key listing HTTP flow', () => {
  let app: NestFastifyApplication;
  let apiKeys: jest.Mocked<OrganizationApiKeyPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;

  let callerRole: OrganizationMembershipRole = 'owner';
  let callerStatus: OrganizationMembershipStatus = 'active';
  let callerMembershipExists = true;
  let organizationStatus: OrganizationStatus = 'active';

  beforeAll(async () => {
    membership = {
      resolveMembership: jest.fn(async ({ organizationId, userId }) => {
        if (!callerMembershipExists) {
          return { kind: 'missing' as const };
        }
        const record = {
          organizationId,
          userId,
          organizationStatus,
          role: callerRole,
          status: callerStatus,
        };
        return callerStatus === 'active'
          ? { kind: 'active' as const, membership: record }
          : { kind: 'disabled' as const, membership: record };
      }),
      listRoster: jest.fn(async (_input: ListRosterInput) => []),
      changeRole: jest.fn(),
      disable: jest.fn(),
      transfer: jest.fn(),
    };
    apiKeys = {
      createApiKey: jest.fn(),
      listApiKeys: jest.fn(
        async (_input: ListOrganizationApiKeysInput) => [] as const,
      ),
      rotateApiKey: jest.fn(),
      revokeApiKey: jest.fn(),
    };

    const tokenIssuer: jest.Mocked<UserAccessTokenIssuerPort> = {
      issue: jest.fn(async (_userId: string) => ({
        token: 'reissued.token.value',
        expiresIn: 900,
      })),
    };
    const verifier: UserAccessTokenVerifierPort = {
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
      findUserAccountStatus: async () => 'active',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_API_KEY)
      .useValue(apiKeys)
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
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
  });

  beforeEach(() => {
    callerRole = 'owner';
    callerStatus = 'active';
    callerMembershipExists = true;
    organizationStatus = 'active';
    jest.clearAllMocks();
    apiKeys.listApiKeys.mockResolvedValue([]);
  });

  function list(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = KEYS_URL,
  ) {
    return app.inject({ method: 'GET', url, headers });
  }

  function listCall(): ListOrganizationApiKeysInput {
    const call = apiKeys.listApiKeys.mock.calls[0];
    if (call === undefined) {
      throw new Error('listApiKeys was not called');
    }
    return call[0];
  }

  it('returns the organization key metadata for an owner', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({
        lastUsedAt: new Date('2026-09-21T08:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ]);

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        api_keys: [
          {
            id: 'ak_01J00000000000000000000001',
            name: 'Prod backend',
            key_prefix: 'aihub_sk_A1b2C3',
            scopes: ['writing.grade'],
            allowed_environments: ['production'],
            status: 'active',
            expires_at: '2027-01-01T00:00:00.000Z',
            last_used_at: '2026-09-21T08:00:00.000Z',
            created_at: '2026-09-20T10:00:00.000Z',
          },
        ],
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns a body the published response contract accepts', async () => {
    apiKeys.listApiKeys.mockResolvedValue([keyRecord()]);

    const response = await list();

    expect(
      Value.Check(ListOrganizationApiKeysResponseSchema, response.json()),
    ).toBe(true);
  });

  it('lists keys for an organization admin', async () => {
    callerRole = 'admin';

    const response = await list();

    expect(response.statusCode).toBe(200);
  });

  // One literal for every refused caller: each case equals it, so no two
  // refusals can differ by status, code, or message.
  it.each<[string, () => void]>([
    [
      'no membership in the organization',
      () => {
        callerMembershipExists = false;
      },
    ],
    [
      'a disabled membership',
      () => {
        callerStatus = 'disabled';
      },
    ],
    [
      'an ordinary member of an active organization',
      () => {
        callerRole = 'member';
      },
    ],
    [
      'an owner of a suspended organization',
      () => {
        organizationStatus = 'suspended';
      },
    ],
  ])(
    'gives %s the same denial without reading keys',
    async (_label, arrange) => {
      arrange();

      const response = await list();

      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 403,
        body: {
          error: {
            code: 'FORBIDDEN',
            message: 'Organization API key access is forbidden',
            request_id: REQUEST_ID,
            retryable: false,
          },
        },
      });
      expect(apiKeys.listApiKeys).not.toHaveBeenCalled();
    },
  );

  it('rejects an unauthenticated request', async () => {
    const response = await list({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.listApiKeys).not.toHaveBeenCalled();
  });

  it('reports an organization with no keys as an empty list', async () => {
    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json().data.api_keys).toEqual([]);
  });

  it('scopes the query to the organization named in the path', async () => {
    await list();

    expect(listCall().organizationId).toBe(ORGANIZATION_ID);
    expect(listCall().context.organizationId).toBe(ORGANIZATION_ID);
  });

  it('reports a key past its expiry as expired rather than active', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({ expiresAt: new Date(Date.now() - 1_000) }),
    ]);

    // The durable row still says active: authentication rejects an expired key
    // through a separate check, so a view over the column alone would call a
    // dead credential live.
    const response = await list();

    expect(response.json().data.api_keys[0].status).toBe('expired');
  });

  it('reports a key with a future expiry as active', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({ expiresAt: new Date(Date.now() + 60_000) }),
    ]);

    const response = await list();

    expect(response.json().data.api_keys[0].status).toBe('active');
  });

  it('reports a key with no expiry as active', async () => {
    apiKeys.listApiKeys.mockResolvedValue([keyRecord({ expiresAt: null })]);

    const response = await list();

    expect(response.json().data.api_keys[0].status).toBe('active');
  });

  it('preserves the order the store yields rather than re-sorting', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000003', name: 'third' }),
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000001', name: 'first' }),
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000002', name: 'second' }),
    ]);

    const response = await list();

    expect(
      response.json().data.api_keys.map((key: { name: string }) => key.name),
    ).toEqual(['third', 'first', 'second']);
  });

  it('exposes no credential material', async () => {
    apiKeys.listApiKeys.mockResolvedValue([keyRecord()]);

    const response = await list();

    expect(response.body).not.toContain('key_hash');
    expect(response.body).not.toContain('api_key"');
    expect(response.body).not.toMatch(/aihub_sk_[A-Za-z0-9]{43}/);
  });

  it('sets no cache-control header, unlike the credential-bearing routes', async () => {
    const response = await list();

    expect(response.headers['cache-control']).toBeUndefined();
  });
});
