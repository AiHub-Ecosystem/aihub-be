import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { AppError } from '@/common/errors/app-error';
import { ReadOrganizationIdentityConfigResponseSchema } from '@/contracts/organization/identity-config';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/membership/application/organization-membership.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
  type SaveOrganizationIdentityConfigInput,
  type StoredOrganizationIdentityConfig,
} from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import { JWKS_CACHE } from '@/modules/identity/user-assertions/application/jwks-cache.port';
import { JWKS_KEY_PROVIDER } from '@/modules/identity/user-assertions/application/jwks-key-provider.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const IDENTITY_CONFIG_URL = `/v1/organizations/${ORGANIZATION_ID}/identity-config`;
const purgeJwks = jest.fn(async (_organizationId: string) => undefined);
const validateRemote = jest.fn(async (_url: string) => undefined);

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
  let auditWrites = 0;
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
      saveForOwner: jest.fn(
        async (input: SaveOrganizationIdentityConfigInput) => {
          const next = config({
            issuer: input.issuer,
            jwksUrl: input.jwksUrl,
            publicKeysJwks: input.publicKeysJwks,
            allowedAlgorithms: input.allowedAlgorithms,
            maxAssertionTtlSeconds: input.maxAssertionTtlSeconds,
            status: result?.status ?? 'active',
            updatedAt: new Date('2026-09-24T12:34:56.000Z'),
          });
          const unchanged =
            result !== null &&
            result.issuer === next.issuer &&
            result.jwksUrl === next.jwksUrl &&
            JSON.stringify(result.publicKeysJwks) ===
              JSON.stringify(next.publicKeysJwks) &&
            JSON.stringify(result.allowedAlgorithms) ===
              JSON.stringify(next.allowedAlgorithms) &&
            result.maxAssertionTtlSeconds === next.maxAssertionTtlSeconds;
          if (!unchanged) {
            auditWrites += 1;
          }
          result = next;
          return {
            kind: unchanged ? ('unchanged' as const) : ('saved' as const),
            config: next,
          };
        },
      ),
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
    const userAccounts = userAccountStatus();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ORGANIZATION_IDENTITY_CONFIG_REPOSITORY)
      .useValue(configs)
      .overrideProvider(JWKS_KEY_PROVIDER)
      .useValue({
        resolve: async () => ({ keys: [] }),
        validateRemote,
      })
      .overrideProvider(JWKS_CACHE)
      .useValue({
        getJwks: async () => undefined,
        setJwks: async () => undefined,
        deleteJwks: purgeJwks,
        tryAcquireRefresh: async () => ({ acquired: true, available: true }),
      })
      .overrideProvider(ORGANIZATION_MEMBERSHIP)
      .useValue(membership)
      .overrideProvider(USER_ACCESS_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(USER_ACCESS_TOKEN_ISSUER)
      .useValue(tokenIssuer)
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
    result = config();
    callerRole = 'owner';
    callerStatus = 'active';
    callerMembershipExists = true;
    organizationStatus = 'active';
    auditWrites = 0;
    purgeJwks.mockReset().mockResolvedValue(undefined);
    validateRemote.mockReset().mockResolvedValue(undefined);
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

  function set(
    payload: Record<string, unknown>,
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
  ) {
    return app.inject({
      method: 'PUT',
      url: IDENTITY_CONFIG_URL,
      headers,
      payload,
    });
  }

  it('creates an identity configuration through the owner Bearer route', async () => {
    const response = await set({
      issuer: 'https://acme.edu',
      public_keys_jwks: {
        keys: [
          { kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'rsa-1', alg: 'RS256' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        configured: true,
        issuer: 'https://acme.edu',
        jwks_url: null,
        public_keys_jwks: {
          keys: [{ kid: 'rsa-1' }],
        },
        allowed_algorithms: ['RS256', 'ES256'],
        max_assertion_ttl_seconds: 300,
        status: 'active',
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it.each([
    ['no key source', { issuer: 'https://acme.edu' }],
    [
      'both key sources',
      {
        issuer: 'https://acme.edu',
        jwks_url: 'https://acme.edu/keys',
        public_keys_jwks: { keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }] },
      },
    ],
    [
      'private key material',
      {
        issuer: 'https://acme.edu',
        public_keys_jwks: {
          keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', d: 'private-material' }],
        },
      },
    ],
    [
      'invalid inline JWKS',
      {
        issuer: 'https://acme.edu',
        public_keys_jwks: { keys: [] },
      },
    ],
  ])(
    'rejects %s without touching storage or cache',
    async (_label, payload) => {
      const response = await set(payload);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(
        _label === 'private key material' || _label === 'invalid inline JWKS'
          ? 'IDENTITY_JWKS_INVALID'
          : 'INVALID_REQUEST',
      );
      expect(configs.saveForOwner).not.toHaveBeenCalled();
      expect(purgeJwks).not.toHaveBeenCalled();
      expect(JSON.stringify(response.json())).not.toContain('private-material');
    },
  );

  it.each([
    ['network failure', true],
    ['timeout', true],
    ['upstream 5xx', true],
    ['upstream 429', true],
    ['upstream 404', false],
  ])(
    'returns a stable source-unavailable response for %s',
    async (_reason, retryable) => {
      validateRemote.mockRejectedValueOnce(
        new AppError({
          code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
          message: 'JWKS source is unavailable',
          retryable,
        }),
      );

      const response = await set({
        issuer: 'https://acme.edu',
        jwks_url: 'https://id.acme.edu/keys',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'IDENTITY_JWKS_SOURCE_UNAVAILABLE',
        message: 'JWKS source is unavailable',
        retryable,
      });
      expect(configs.saveForOwner).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid public key material with the stable JWKS error', async () => {
    const response = await set({
      issuer: 'https://acme.edu',
      public_keys_jwks: {
        keys: [{ kty: 'RSA', n: 'not_base64url!', e: 'AQAB' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'IDENTITY_JWKS_INVALID',
      retryable: false,
    });
    expect(configs.saveForOwner).not.toHaveBeenCalled();
  });

  it('classifies a non-HTTPS source as unsafe before fetching', async () => {
    const response = await set({
      issuer: 'https://acme.edu',
      jwks_url: 'http://id.acme.edu/keys',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'IDENTITY_JWKS_URL_UNSAFE',
      retryable: false,
    });
    expect(validateRemote).not.toHaveBeenCalled();
  });

  it('classifies a valid HTTP response with unsupported JWKS as invalid', async () => {
    validateRemote.mockRejectedValueOnce(
      new AppError({
        code: 'IDENTITY_JWKS_INVALID',
        message: 'Public JWKS is invalid',
        retryable: false,
      }),
    );

    const response = await set({
      issuer: 'https://acme.edu',
      jwks_url: 'https://id.acme.edu/keys',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'IDENTITY_JWKS_INVALID',
      retryable: false,
    });
    expect(configs.saveForOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked private destination', 'https://10.0.0.8/keys'],
    ['rejected redirect', 'https://id.acme.edu/keys'],
  ])('returns the safe unsafe-URL error for a %s', async (_reason, url) => {
    validateRemote.mockRejectedValueOnce(
      new AppError({
        code: 'IDENTITY_JWKS_URL_UNSAFE',
        message: 'JWKS URL is not safe',
        retryable: false,
      }),
    );

    const response = await set({ issuer: 'https://acme.edu', jwks_url: url });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'IDENTITY_JWKS_URL_UNSAFE',
      message: 'JWKS URL is not safe',
      retryable: false,
    });
    expect(response.payload).not.toContain('10.0.0.8');
    expect(response.payload).not.toContain('id.acme.edu');
    expect(configs.saveForOwner).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ['admin', () => (callerRole = 'admin')],
    ['member', () => (callerRole = 'member')],
    ['disabled owner', () => (callerStatus = 'disabled')],
    ['non-member', () => (callerMembershipExists = false)],
    [
      'owner of a suspended Organization',
      () => (organizationStatus = 'suspended'),
    ],
  ])(
    'gives a %s the same denial before URL validation or persistence',
    async (_label, arrange) => {
      arrange();

      const response = await set({
        issuer: 'https://acme.edu',
        jwks_url: 'https://id.acme.edu/keys',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Organization identity configuration access is forbidden',
      });
      expect(validateRemote).not.toHaveBeenCalled();
      expect(configs.saveForOwner).not.toHaveBeenCalled();
      expect(purgeJwks).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', {}],
    ['invalid', { authorization: 'Bearer invalid.token.value' }],
  ])('rejects %s PUT Bearer credentials', async (_label, headers) => {
    const response = await set(
      {
        issuer: 'https://acme.edu',
        public_keys_jwks: {
          keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }],
        },
      },
      headers,
    );

    expect(response.statusCode).toBe(401);
    expect(configs.saveForOwner).not.toHaveBeenCalled();
  });

  it('maps an issuer already used by another Organization to a safe conflict', async () => {
    configs.saveForOwner.mockRejectedValueOnce(
      new AppError({
        code: 'ORGANIZATION_IDENTITY_ISSUER_CONFLICT',
        message: 'Issuer is already configured for another Organization',
        retryable: false,
      }),
    );

    const response = await set({
      issuer: 'https://other.edu',
      public_keys_jwks: {
        keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB' }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      'ORGANIZATION_IDENTITY_ISSUER_CONFLICT',
    );
    expect(purgeJwks).not.toHaveBeenCalled();
  });

  it('retries cache purge after a durable save without duplicating its audit event', async () => {
    purgeJwks.mockRejectedValueOnce(new Error('Redis host and password'));
    const payload = {
      issuer: 'https://acme.edu',
      public_keys_jwks: {
        keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'new-key' }],
      },
    };

    const failed = await set(payload);
    const retried = await set(payload);

    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toMatchObject({
      code: 'IDENTITY_CONFIG_CACHE_UNAVAILABLE',
      retryable: true,
    });
    expect(JSON.stringify(failed.json())).not.toContain('Redis host');
    expect(retried.statusCode).toBe(200);
    expect(purgeJwks).toHaveBeenCalledTimes(2);
    expect(configs.saveForOwner).toHaveBeenCalledTimes(2);
    expect(auditWrites).toBe(1);
  });

  it('preserves a disabled status when an owner replaces the configuration', async () => {
    result = config({ status: 'disabled' });

    const response = await set({
      issuer: 'https://acme.edu',
      public_keys_jwks: {
        keys: [{ kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'new-key' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      configured: true,
      status: 'disabled',
    });
  });

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

  it.each(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'])(
    'rejects private JWK member %s in the published response schema',
    async (member) => {
      const response = await read();
      const body = response.json();
      const unsafeBody = {
        ...body,
        data: {
          ...body.data,
          public_keys_jwks: {
            keys: [
              { ...body.data.public_keys_jwks.keys[0], [member]: 'private' },
            ],
          },
        },
      };

      expect(
        Value.Check(ReadOrganizationIdentityConfigResponseSchema, unsafeBody),
      ).toBe(false);
    },
  );
});
