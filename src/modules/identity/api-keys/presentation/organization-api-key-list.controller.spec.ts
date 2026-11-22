import { QueryBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { ListOrganizationApiKeysResponseSchema } from '@/contracts/organization/api-key';
import {
  type ListOrganizationApiKeysInput,
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type OrganizationApiKeyRecord,
} from '@/modules/identity/api-keys/application/organization-api-key.port';
import { ListOrganizationApiKeysQuery } from '@/modules/identity/api-keys/presentation/organization-api-key.cqrs';
import {
  OrganizationAdmissionHarness,
  applyOrganizationAdmissionModuleOverrides,
  createMockOrganizationApiKeyPort,
  expectAuthorizationDenial,
  initOrganizationTestApp,
} from '@/modules/identity/testing/organization-admission.spec-support';

const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const KEYS_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys`;

function listBody(response: { json(): unknown }) {
  return Value.Parse(ListOrganizationApiKeysResponseSchema, response.json());
}

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
    createdByUsername: null,
    lastRotatedByUsername: null,
    ...overrides,
  };
}

describe('Organization API key listing HTTP flow', () => {
  let app: NestFastifyApplication;
  let apiKeys: jest.Mocked<OrganizationApiKeyPort>;
  const admission = new OrganizationAdmissionHarness();

  beforeAll(async () => {
    apiKeys = createMockOrganizationApiKeyPort();

    const moduleRef = await applyOrganizationAdmissionModuleOverrides(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ORGANIZATION_API_KEY)
        .useValue(apiKeys),
      admission,
    ).compile();

    app = await initOrganizationTestApp(moduleRef, { requestId: REQUEST_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    admission.reset();
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
    const execute = jest.spyOn(app.get(QueryBus), 'execute');
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({
        lastUsedAt: new Date('2026-09-21T08:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ]);

    const response = await list();

    expect(execute).toHaveBeenCalledWith(
      expect.any(ListOrganizationApiKeysQuery),
    );
    expect(response.statusCode).toBe(200);
    expect(listBody(response)).toEqual({
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
            created_by: null,
            last_rotated_by: null,
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
      Value.Check(
        ListOrganizationApiKeysResponseSchema,
        response.json<unknown>(),
      ),
    ).toBe(true);
  });

  it('lists keys for an organization admin', async () => {
    admission.callerRole = 'admin';

    const response = await list();

    expect(response.statusCode).toBe(200);
  });

  // One literal for every refused caller: each case equals it, so no two
  // refusals can differ by status, code, or message.
  it.each<[string, () => void]>(admission.readDenialCases())(
    'gives %s the same denial without reading keys',
    async (_label, arrange) => {
      arrange();

      const response = await list();

      expectAuthorizationDenial(response, {
        message: 'Organization API key access is forbidden',
        requestId: REQUEST_ID,
      });
      expect(apiKeys.listApiKeys.mock.calls).toHaveLength(0);
    },
  );

  it('rejects an unauthenticated request', async () => {
    const response = await list({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.listApiKeys.mock.calls).toHaveLength(0);
  });

  it('reports an organization with no keys as an empty list', async () => {
    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(listBody(response).data.api_keys).toEqual([]);
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

    expect(listBody(response).data.api_keys[0]?.status).toBe('expired');
  });

  it('reports a key with a future expiry as active', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({ expiresAt: new Date(Date.now() + 60_000) }),
    ]);

    const response = await list();

    expect(listBody(response).data.api_keys[0]?.status).toBe('active');
  });

  it('reports a key with no expiry as active', async () => {
    apiKeys.listApiKeys.mockResolvedValue([keyRecord({ expiresAt: null })]);

    const response = await list();

    expect(listBody(response).data.api_keys[0]?.status).toBe('active');
  });

  it('preserves the order the store yields rather than re-sorting', async () => {
    apiKeys.listApiKeys.mockResolvedValue([
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000003', name: 'third' }),
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000001', name: 'first' }),
      keyRecord({ apiKeyId: 'ak_01J00000000000000000000002', name: 'second' }),
    ]);

    const response = await list();

    expect(listBody(response).data.api_keys.map(({ name }) => name)).toEqual([
      'third',
      'first',
      'second',
    ]);
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
