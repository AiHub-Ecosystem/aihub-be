import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '../../../app.module';
import { OrganizationApiKeySecretResponseSchema } from '../../../contracts/organization/api-key';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '../../auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '../../auth/application/user-account.port';
import { userAccountStatus } from '../../auth/testing/user-account-status.stub';
import {
  API_KEY_CACHE,
  type ApiKeyCachePort,
} from '../application/api-key-authenticator.port';
import {
  type ListOrganizationApiKeysInput,
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type RotateOrganizationApiKeyRecordInput,
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
const RETIRED_KEY_ID = 'ak_01J00000000000000000000001';
const ROTATE_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys/${RETIRED_KEY_ID}/rotate`;
const CREATED_AT = new Date('2026-09-21T10:00:00.000Z');
const INHERITED_EXPIRY = new Date('2027-01-01T00:00:00.000Z');
const RETIRED_HASH = 'a'.repeat(64);

type OrganizationStatus = 'active' | 'suspended';

function rotated() {
  return {
    kind: 'rotated' as const,
    retiredKeyHash: RETIRED_HASH,
    name: 'Prod backend',
    scopes: ['writing.grade'] as readonly string[],
    allowedEnvironments: ['production'] as readonly string[],
    expiresAt: INHERITED_EXPIRY,
    createdAt: CREATED_AT,
  };
}

describe('Organization API key rotation HTTP flow', () => {
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
      rotateApiKey: jest.fn(
        async (_input: RotateOrganizationApiKeyRecordInput) => rotated(),
      ),
      revokeApiKey: jest.fn(),
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
    const userAccounts = userAccountStatus();

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
    callerRole = 'owner';
    callerStatus = 'active';
    callerMembershipExists = true;
    organizationStatus = 'active';
    jest.clearAllMocks();
    apiKeys.rotateApiKey.mockResolvedValue(rotated());
    cache.delete.mockResolvedValue(undefined);
  });

  function rotate(
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = ROTATE_URL,
  ) {
    return app.inject({ method: 'POST', url, headers });
  }

  function rotateCall(): RotateOrganizationApiKeyRecordInput {
    const call = apiKeys.rotateApiKey.mock.calls[0];
    if (call === undefined) {
      throw new Error('rotateApiKey was not called');
    }
    return call[0];
  }

  it('returns the raw replacement once with the inherited key metadata', async () => {
    const response = await rotate();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        api_key: expect.stringMatching(/^aihub_sk_[A-Za-z0-9]{43}$/),
        id: expect.stringMatching(/^ak_[0-9A-HJKMNP-TV-Z]{26}$/),
        name: 'Prod backend',
        key_prefix: expect.stringMatching(/^aihub_sk_[A-Za-z0-9]{6}$/),
        scopes: ['writing.grade'],
        allowed_environments: ['production'],
        status: 'active',
        expires_at: INHERITED_EXPIRY.toISOString(),
        last_used_at: null,
        created_at: CREATED_AT.toISOString(),
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns a body the published response contract accepts', async () => {
    const response = await rotate();

    expect(
      Value.Check(OrganizationApiKeySecretResponseSchema, response.json()),
    ).toBe(true);
  });

  it('gives the replacement its own identifier, not the retired one', async () => {
    const response = await rotate();

    expect(response.json().data.id).not.toBe(RETIRED_KEY_ID);
    expect(rotateCall().apiKeyId).toBe(RETIRED_KEY_ID);
    expect(rotateCall().replacementId).toBe(response.json().data.id);
  });

  it('marks the credential response uncacheable', async () => {
    const response = await rotate();

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('purges the identity cache entry of the retired key', async () => {
    await rotate();

    expect(cache.delete).toHaveBeenCalledWith(RETIRED_HASH);
  });

  it('still returns the replacement when the cache purge fails', async () => {
    cache.delete.mockRejectedValue(new Error('redis is unreachable'));

    const response = await rotate();

    // The durable rotation is already committed. Failing the request here
    // would withhold the only copy of a credential the caller now has to use,
    // while the old one is already revoked.
    expect(response.statusCode).toBe(200);
    expect(response.json().data.api_key).toMatch(/^aihub_sk_[A-Za-z0-9]{43}$/);
  });

  it('never discloses the retired key hash', async () => {
    const response = await rotate();

    expect(response.body).not.toContain(RETIRED_HASH);
  });

  it('persists only the replacement hash, never its raw credential', async () => {
    const response = await rotate();

    const persisted = rotateCall();
    const rawKey: string = response.json().data.api_key;
    expect(persisted.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(rawKey);
    expect(persisted.keyPrefix).toBe(rawKey.slice(0, 15));
    expect(persisted.organizationId).toBe(ORGANIZATION_ID);
  });

  it('rotates for an organization admin', async () => {
    callerRole = 'admin';

    const response = await rotate();

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
        apiKeys.rotateApiKey.mockResolvedValue({
          kind: 'organization_unavailable',
        });
      },
      true,
    ],
  ])('gives %s the same denial', async (_label, arrange, storeReached) => {
    arrange();

    const response = await rotate();

    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'Organization API key rotation is forbidden',
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    });
    expect(apiKeys.rotateApiKey.mock.calls.length > 0).toBe(storeReached);
    // No refusal purges a cache entry: nothing was withdrawn.
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const response = await rotate({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.rotateApiKey).not.toHaveBeenCalled();
  });

  it('reports an unknown key as not found', async () => {
    apiKeys.rotateApiKey.mockResolvedValue({ kind: 'key_not_found' });

    const response = await rotate();

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('reports a revoked or expired key as forbidden', async () => {
    apiKeys.rotateApiKey.mockResolvedValue({ kind: 'key_not_rotatable' });

    const response = await rotate();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('issues a distinct replacement on every rotation', async () => {
    const first = await rotate();
    const second = await rotate();

    expect(first.json().data.api_key).not.toBe(second.json().data.api_key);
    expect(first.json().data.id).not.toBe(second.json().data.id);
  });
});
