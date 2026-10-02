import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { OrganizationApiKeySecretResponseSchema } from '@/contracts/organization/api-key';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenIssuerPort,
  type UserAccessTokenVerifierPort,
} from '@/modules/auth/application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from '@/modules/auth/application/user-account.port';
import { userAccountStatus } from '@/modules/auth/testing/user-account-status.stub';
import {
  type CreateOrganizationApiKeyRecordInput,
  type ListOrganizationApiKeysInput,
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
} from '@/modules/identity/application/organization-api-key.port';
import {
  type ListRosterInput,
  ORGANIZATION_MEMBERSHIP,
  type OrganizationMembershipPort,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from '@/modules/identity/application/organization-membership.port';

const USER_ID = 'usr_01J00000000000000000000000';
const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const KEYS_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys`;
const CREATED_AT = new Date('2026-09-21T10:00:00.000Z');

type OrganizationStatus = 'active' | 'suspended';

describe('Organization API key creation HTTP flow', () => {
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
      createApiKey: jest.fn(
        async (_input: CreateOrganizationApiKeyRecordInput) => ({
          kind: 'created' as const,
          createdAt: CREATED_AT,
        }),
      ),
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
    const userAccounts = userAccountStatus();

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
    apiKeys.createApiKey.mockResolvedValue({
      kind: 'created',
      createdAt: CREATED_AT,
    });
  });

  function create(
    payload: object = { name: 'Prod backend', scopes: ['writing.grade'] },
    headers: Record<string, string> = {
      authorization: 'Bearer valid.token.value',
    },
    url = KEYS_URL,
  ) {
    return app.inject({ method: 'POST', url, headers, payload });
  }

  function createCall(): CreateOrganizationApiKeyRecordInput {
    const call = apiKeys.createApiKey.mock.calls[0];
    if (call === undefined) {
      throw new Error('createApiKey was not called');
    }
    return call[0];
  }

  it('returns the raw credential once with the durable key metadata', async () => {
    const response = await create();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: {
        api_key: expect.stringMatching(/^aihub_sk_[A-Za-z0-9]{43}$/),
        id: expect.stringMatching(/^ak_[0-9A-HJKMNP-TV-Z]{26}$/),
        name: 'Prod backend',
        key_prefix: expect.stringMatching(/^aihub_sk_[A-Za-z0-9]{6}$/),
        scopes: ['writing.grade'],
        allowed_environments: ['production'],
        status: 'active',
        expires_at: null,
        last_used_at: null,
        created_at: CREATED_AT.toISOString(),
      },
      meta: { request_id: REQUEST_ID },
    });
  });

  it('returns a body the published response contract accepts', async () => {
    const response = await create();

    // The contract is what integrators generate clients from, so a response
    // the published schema rejects is a broken contract, not a passing test.
    expect(
      Value.Check(OrganizationApiKeySecretResponseSchema, response.json()),
    ).toBe(true);
  });

  it('derives the display prefix from the raw credential it returns', async () => {
    const response = await create();

    const { api_key: rawKey, key_prefix: prefix } = response.json().data;
    expect(prefix).toBe(rawKey.slice(0, 15));
  });

  it('marks the credential response uncacheable', async () => {
    const response = await create();

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('persists only the credential hash, never the raw credential', async () => {
    const response = await create();

    const persisted = createCall();
    const rawKey: string = response.json().data.api_key;
    expect(persisted.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.keyHash).not.toContain(rawKey);
    expect(JSON.stringify(persisted)).not.toContain(rawKey);
    expect(persisted.organizationId).toBe(ORGANIZATION_ID);
    expect(persisted.keyPrefix).toBe(rawKey.slice(0, 15));
  });

  it('creates a key for an organization admin', async () => {
    callerRole = 'admin';

    const response = await create();

    expect(response.statusCode).toBe(201);
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
        apiKeys.createApiKey.mockResolvedValue({
          kind: 'organization_unavailable',
        });
      },
      true,
    ],
  ])('gives %s the same denial', async (_label, arrange, storeReached) => {
    arrange();

    const response = await create();

    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 403,
      body: {
        error: {
          code: 'FORBIDDEN',
          message: 'Organization API key creation is forbidden',
          request_id: REQUEST_ID,
          retryable: false,
        },
      },
    });
    expect(apiKeys.createApiKey.mock.calls.length > 0).toBe(storeReached);
  });

  it('rejects a scope no operation requires', async () => {
    const response = await create({
      name: 'Prod backend',
      scopes: ['billing.admin'],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects an empty scope list', async () => {
    const response = await create({ name: 'Prod backend', scopes: [] });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('forwards the entitlements the requested scopes require', async () => {
    await create({
      name: 'Prod backend',
      scopes: ['writing.grade', 'speaking.grade'],
    });

    expect(createCall().requiredEntitlements).toEqual(['writing', 'speaking']);
  });

  it('denies a scope the organization is not entitled to', async () => {
    apiKeys.createApiKey.mockResolvedValue({ kind: 'entitlements_missing' });

    const response = await create({
      name: 'Prod backend',
      scopes: ['speaking.grade'],
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('denies creation once the organization reaches its active key limit', async () => {
    apiKeys.createApiKey.mockResolvedValue({ kind: 'limit_reached' });

    const response = await create();

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('binds the key to the requested customer environments', async () => {
    const response = await create({
      name: 'Staging backend',
      scopes: ['writing.grade'],
      allowed_environments: ['staging'],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.allowed_environments).toEqual(['staging']);
    expect(createCall().allowedEnvironments).toEqual(['staging']);
  });

  it('creates a Writing-only key restricted to the sandbox environment', async () => {
    const response = await create({
      name: 'Sandbox test key',
      scopes: ['writing.grade'],
      allowed_environments: ['sandbox'],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.allowed_environments).toEqual(['sandbox']);
    expect(response.json().data.scopes).toEqual(['writing.grade']);
    expect(createCall().allowedEnvironments).toEqual(['sandbox']);
    expect(createCall().scopes).toEqual(['writing.grade']);
  });

  it('rejects an environment that is not customer-facing', async () => {
    const response = await create({
      name: 'Sneaky',
      scopes: ['writing.grade'],
      allowed_environments: ['development'],
    });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'combines sandbox with another environment',
      payload: {
        name: 'Sandbox and production',
        scopes: ['writing.grade'],
        allowed_environments: ['sandbox', 'production'],
      },
    },
    {
      name: 'requests a non-Writing scope',
      payload: {
        name: 'Sandbox Speaking',
        scopes: ['speaking.grade'],
        allowed_environments: ['sandbox'],
      },
    },
  ])('rejects a Sandbox key that $name', async ({ payload }) => {
    const response = await create(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects an empty environment list', async () => {
    const response = await create({
      name: 'Prod backend',
      scopes: ['writing.grade'],
      allowed_environments: [],
    });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('stores no expiry when none is requested', async () => {
    await create();

    expect(createCall().expiresAt).toBeNull();
  });

  it('binds the requested expiry to the key', async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const response = await create({
      name: 'Short lived',
      scopes: ['writing.grade'],
      expires_at: expiresAt.toISOString(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.expires_at).toBe(expiresAt.toISOString());
    expect(createCall().expiresAt).toEqual(expiresAt);
  });

  it('rejects an expiry in the past', async () => {
    const response = await create({
      name: 'Dead on arrival',
      scopes: ['writing.grade'],
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects an expiry beyond the maximum key lifetime', async () => {
    const response = await create({
      name: 'Forever',
      scopes: ['writing.grade'],
      expires_at: new Date(
        Date.now() + 366 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects an unknown request property', async () => {
    const response = await create({
      name: 'Prod backend',
      scopes: ['writing.grade'],
      status: 'revoked',
    });

    expect(response.statusCode).toBe(400);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const response = await create(
      { name: 'Prod backend', scopes: ['writing.grade'] },
      {},
    );

    expect(response.statusCode).toBe(401);
    expect(apiKeys.createApiKey).not.toHaveBeenCalled();
  });

  it('issues a distinct credential on every creation', async () => {
    const first = await create();
    const second = await create();

    expect(first.json().data.api_key).not.toBe(second.json().data.api_key);
    expect(first.json().data.id).not.toBe(second.json().data.id);
  });
});
