import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '../../../app.module';
import { RevokeOrganizationApiKeyResponseSchema } from '../../../contracts/organization/api-key';
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
  API_KEY_CACHE,
  type ApiKeyCachePort,
} from '../application/api-key-authenticator.port';
import {
  type ListOrganizationApiKeysInput,
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type RevokeOrganizationApiKeyRecordInput,
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
const KEY_ID = 'ak_01J00000000000000000000001';
const REVOKE_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys/${KEY_ID}`;
const CREATED_AT = new Date('2026-09-20T10:00:00.000Z');
const KEY_HASH = 'b'.repeat(64);

type OrganizationStatus = 'active' | 'suspended';

function revoked() {
  return {
    kind: 'revoked' as const,
    keyHash: KEY_HASH,
    key: {
      apiKeyId: KEY_ID,
      name: 'Prod backend',
      keyPrefix: 'aihub_sk_A1b2C3',
      scopes: ['writing.grade'] as readonly string[],
      allowedEnvironments: ['production'] as readonly string[],
      status: 'revoked' as const,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: CREATED_AT,
    },
  };
}

describe('Organization API key revocation HTTP flow', () => {
  let app: NestFastifyApplication;
  let apiKeys: jest.Mocked<OrganizationApiKeyPort>;
  let membership: jest.Mocked<OrganizationMembershipPort>;
  let cache: jest.Mocked<ApiKeyCachePort>;

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
      revokeApiKey: jest.fn(
        async (_input: RevokeOrganizationApiKeyRecordInput) => revoked(),
      ),
    };
    cache = {
      get: jest.fn(),
      set: jest.fn(),
      setMiss: jest.fn(),
      delete: jest.fn(async (_hashHex: string) => undefined),
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
      .overrideProvider(API_KEY_CACHE)
      .useValue(cache)
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
    apiKeys.revokeApiKey.mockResolvedValue(revoked());
    cache.delete.mockResolvedValue(undefined);
  });

  function revoke(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = REVOKE_URL,
  ) {
    return app.inject({ method: 'DELETE', url, headers });
  }

  function revokeCall(): RevokeOrganizationApiKeyRecordInput {
    const call = apiKeys.revokeApiKey.mock.calls[0];
    if (call === undefined) {
      throw new Error('revokeApiKey was not called');
    }
    return call[0];
  }

  it('returns the withdrawn key metadata with the published revoked status', async () => {
    const response = await revoke();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        id: KEY_ID,
        name: 'Prod backend',
        key_prefix: 'aihub_sk_A1b2C3',
        scopes: ['writing.grade'],
        allowed_environments: ['production'],
        status: 'revoked',
        expires_at: null,
        last_used_at: null,
        created_at: CREATED_AT.toISOString(),
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns a body the published response contract accepts', async () => {
    const response = await revoke();

    expect(
      Value.Check(RevokeOrganizationApiKeyResponseSchema, response.json()),
    ).toBe(true);
  });

  it('scopes the withdrawal to the organization and key named in the path', async () => {
    await revoke();

    expect(revokeCall().organizationId).toBe(ORGANIZATION_ID);
    expect(revokeCall().apiKeyId).toBe(KEY_ID);
    expect(revokeCall().context.organizationId).toBe(ORGANIZATION_ID);
  });

  it('purges the identity cache entry of the withdrawn key', async () => {
    await revoke();

    expect(cache.delete).toHaveBeenCalledWith(KEY_HASH);
  });

  it('purges again on a repeated withdrawal, so a retry closes a window a failed purge left open', async () => {
    await revoke();
    await revoke();

    expect(cache.delete).toHaveBeenCalledTimes(2);
    expect(cache.delete).toHaveBeenLastCalledWith(KEY_HASH);
  });

  it('succeeds on a repeated withdrawal rather than reporting a conflict', async () => {
    await revoke();
    const second = await revoke();

    expect(second.statusCode).toBe(200);
    expect(second.json().data.status).toBe('revoked');
  });

  it('still succeeds when the cache purge fails', async () => {
    cache.delete.mockRejectedValue(new Error('redis is unreachable'));

    const response = await revoke();

    // The withdrawal is committed by then; failing here would report work
    // that already happened as if it had not.
    expect(response.statusCode).toBe(200);
  });

  it('never discloses the key hash', async () => {
    const response = await revoke();

    expect(response.body).not.toContain(KEY_HASH);
  });

  it('sets no cache-control header, unlike the credential-bearing routes', async () => {
    const response = await revoke();

    expect(response.headers['cache-control']).toBeUndefined();
  });

  it('withdraws for an organization admin', async () => {
    callerRole = 'admin';

    const response = await revoke();

    expect(response.statusCode).toBe(200);
  });

  // One literal for every caller outside this route's authority: each case
  // equals it, so no two refusals can differ by status, code, or message.
  it.each<[string, () => void, boolean]>([
    [
      'no membership in the organization',
      () => {
        callerMembershipExists = false;
      },
      false,
    ],
    [
      'a disabled membership',
      () => {
        callerStatus = 'disabled';
      },
      false,
    ],
    [
      'an ordinary member of an active organization',
      () => {
        callerRole = 'member';
      },
      false,
    ],
    [
      'an owner of a suspended organization',
      () => {
        organizationStatus = 'suspended';
      },
      false,
    ],
    [
      'an organization suspended inside the transaction',
      () => {
        apiKeys.revokeApiKey.mockResolvedValue({
          kind: 'organization_unavailable',
        });
      },
      true,
    ],
  ])('gives %s the same denial', async (_label, arrange, storeReached) => {
    arrange();

    const response = await revoke();

    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'Organization API key revocation is forbidden',
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    });
    expect(apiKeys.revokeApiKey.mock.calls.length > 0).toBe(storeReached);
    // No refusal purges a cache entry: nothing was withdrawn.
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const response = await revoke({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.revokeApiKey).not.toHaveBeenCalled();
  });

  it('reports an unknown key as not found', async () => {
    apiKeys.revokeApiKey.mockResolvedValue({ kind: 'key_not_found' });

    const response = await revoke();

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(cache.delete).not.toHaveBeenCalled();
  });
});
