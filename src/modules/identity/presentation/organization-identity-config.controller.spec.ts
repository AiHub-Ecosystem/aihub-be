import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '../../../app.module';
import { ReadOrganizationIdentityConfigResponseSchema } from '../../../contracts/organization/identity-config';
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
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
  type StoredOrganizationIdentityConfig,
} from '../application/organization-identity-config-repository.port';
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
const IDENTITY_CONFIG_URL = `/v1/organizations/${ORGANIZATION_ID}/identity-config`;

type OrganizationStatus = 'active' | 'suspended';

function config(
  overrides: Partial<StoredOrganizationIdentityConfig> = {},
): StoredOrganizationIdentityConfig {
  return {
    organizationId: ORGANIZATION_ID,
    issuer: 'https://acme.edu',
    jwksUrl: 'https://acme.edu/.well-known/jwks.json',
    publicKeysJwks: {
      keys: [
        {
          kty: 'RSA',
          n: 'AQAB',
          e: 'AQAB',
          kid: 'rsa-1',
          alg: 'RS256',
        },
      ],
    },
    allowedAlgorithms: ['RS256', 'ES256'],
    maxAssertionTtlSeconds: 300,
    status: 'active',
    updatedAt: new Date('2026-09-22T12:34:56.000Z'),
    ...overrides,
  };
}

describe('Organization identity configuration HTTP flow', () => {
  let app: NestFastifyApplication;
  let configs: jest.Mocked<OrganizationIdentityConfigRepositoryPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;

  let result: StoredOrganizationIdentityConfig | null = config();
  let callerRole: OrganizationMembershipRole = 'owner';
  let callerStatus: OrganizationMembershipStatus = 'active';
  let callerMembershipExists = true;
  let organizationStatus: OrganizationStatus = 'active';

  beforeAll(async () => {
    configs = {
      findActiveByOrganizationId: jest.fn(
        async (_organizationId: string) => null,
      ),
      findByOrganizationId: jest.fn(async (_organizationId: string) => result),
    };
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
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue(configs)
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
    result = config();
    callerRole = 'owner';
    callerStatus = 'active';
    callerMembershipExists = true;
    organizationStatus = 'active';
    jest.clearAllMocks();
  });

  function read(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = IDENTITY_CONFIG_URL,
  ) {
    return app.inject({ method: 'GET', url, headers });
  }

  it('returns the complete public configuration for an owner', async () => {
    const response = await read();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        configured: true,
        issuer: 'https://acme.edu',
        jwks_url: 'https://acme.edu/.well-known/jwks.json',
        public_keys_jwks: {
          keys: [
            {
              kty: 'RSA',
              n: 'AQAB',
              e: 'AQAB',
              kid: 'rsa-1',
              alg: 'RS256',
            },
          ],
        },
        allowed_algorithms: ['RS256', 'ES256'],
        max_assertion_ttl_seconds: 300,
        status: 'active',
        updated_at: '2026-09-22T12:34:56.000Z',
      },
      meta: { request_id: REQUEST_ID },
    });
    expect(
      Value.Check(
        ReadOrganizationIdentityConfigResponseSchema,
        response.json(),
      ),
    ).toBe(true);
  });

  it('returns a disabled row as configured with its disabled status', async () => {
    result = config({ status: 'disabled' });

    const response = await read();

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      configured: true,
      status: 'disabled',
    });
  });

  it('returns null for the unused key source', async () => {
    result = config({ publicKeysJwks: null });

    const response = await read();

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      jwks_url: 'https://acme.edu/.well-known/jwks.json',
      public_keys_jwks: null,
    });
    expect(
      Value.Check(
        ReadOrganizationIdentityConfigResponseSchema,
        response.json(),
      ),
    ).toBe(true);
  });

  it('returns only configured=false when no row exists', async () => {
    result = null;

    const response = await read();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { configured: false },
      meta: { request_id: REQUEST_ID },
    });
    expect(
      Value.Check(
        ReadOrganizationIdentityConfigResponseSchema,
        response.json(),
      ),
    ).toBe(true);
  });

  it.each<[string, () => void]>([
    ['an admin', () => (callerRole = 'admin')],
    ['a member', () => (callerRole = 'member')],
    ['a disabled owner', () => (callerStatus = 'disabled')],
    ['a non-member', () => (callerMembershipExists = false)],
    [
      'an owner of a suspended Organization',
      () => (organizationStatus = 'suspended'),
    ],
  ])(
    'gives %s the same denial without reading configuration',
    async (_label, arrange) => {
      arrange();

      const response = await read();

      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 403,
        body: {
          error: {
            code: 'FORBIDDEN',
            message: 'Organization identity configuration access is forbidden',
            request_id: REQUEST_ID,
            retryable: false,
          },
        },
      });
      expect(configs.findByOrganizationId).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', {}],
    ['invalid', { authorization: 'Bearer invalid.token.value' }],
  ])('rejects %s Bearer credentials', async (_label, headers) => {
    const response = await read(headers);

    expect(response.statusCode).toBe(401);
    expect(configs.findByOrganizationId).not.toHaveBeenCalled();
  });

  it('scopes membership and configuration reads to the path Organization', async () => {
    const response = await read(
      { authorization: 'Bearer valid.token.value' },
      '/v1/organizations/org_other/identity-config',
    );

    expect(response.statusCode).toBe(200);
    expect(membership.resolveMembership).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_other', userId: USER_ID }),
    );
    expect(configs.findByOrganizationId).toHaveBeenCalledWith('org_other');
  });

  it('returns public JWK fields without private key members', async () => {
    const response = await read();
    const key = response.json().data.public_keys_jwks.keys[0];

    expect(Object.keys(key)).not.toEqual(
      expect.arrayContaining(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
    );
  });

  it('rejects private JWK members in the published response schema', async () => {
    const response = await read();
    const body = response.json();
    const unsafeBody = {
      ...body,
      data: {
        ...body.data,
        public_keys_jwks: {
          keys: [{ ...body.data.public_keys_jwks.keys[0], d: 'private' }],
        },
      },
    };

    expect(
      Value.Check(ReadOrganizationIdentityConfigResponseSchema, unsafeBody),
    ).toBe(false);
  });
});
