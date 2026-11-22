import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { RevokeOrganizationApiKeyResponseSchema } from '@/contracts/organization/api-key';
import {
  API_KEY_CACHE,
  type ApiKeyCachePort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type RevokeOrganizationApiKeyRecordInput,
} from '@/modules/identity/api-keys/application/organization-api-key.port';
import { RevokeOrganizationApiKeyCommand } from '@/modules/identity/api-keys/presentation/organization-api-key.cqrs';
import {
  OrganizationAdmissionHarness,
  applyOrganizationAdmissionModuleOverrides,
  createMockApiKeyCache,
  createMockOrganizationApiKeyPort,
  expectAuthorizationDenial,
  initOrganizationTestApp,
} from '@/modules/identity/testing/organization-admission.spec-support';

const ORGANIZATION_ID = 'org_acme';
const REQUEST_ID = 'req_01J00000000000000000000000';
const KEY_ID = 'ak_01J00000000000000000000001';
const REVOKE_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys/${KEY_ID}`;
const CREATED_AT = new Date('2026-09-20T10:00:00.000Z');
const KEY_HASH = 'b'.repeat(64);

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
      createdByUsername: null,
      lastRotatedByUsername: null,
    },
  };
}

describe('Organization API key revocation HTTP flow', () => {
  let app: NestFastifyApplication;
  let apiKeys: jest.Mocked<OrganizationApiKeyPort>;
  let cache: jest.Mocked<ApiKeyCachePort>;
  const admission = new OrganizationAdmissionHarness();

  beforeAll(async () => {
    apiKeys = createMockOrganizationApiKeyPort({
      revokeApiKey: jest.fn().mockResolvedValue(revoked()),
    });
    cache = createMockApiKeyCache();

    const moduleRef = await applyOrganizationAdmissionModuleOverrides(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ORGANIZATION_API_KEY)
        .useValue(apiKeys)
        .overrideProvider(API_KEY_CACHE)
        .useValue(cache),
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
    const execute = jest.spyOn(app.get(CommandBus), 'execute');
    const response = await revoke();

    expect(execute).toHaveBeenCalledWith(
      expect.any(RevokeOrganizationApiKeyCommand),
    );
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
        created_by: null,
        last_rotated_by: null,
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

    expect(cache.delete.mock.calls).toContainEqual([
      KEY_HASH,
      'api_key_cache_invalidation_revoke',
    ]);
  });

  it('purges again on a repeated withdrawal, so a retry closes a window a failed purge left open', async () => {
    await revoke();
    await revoke();

    expect(cache.delete.mock.calls).toHaveLength(2);
    expect(cache.delete.mock.calls.at(-1)).toEqual([
      KEY_HASH,
      'api_key_cache_invalidation_revoke',
    ]);
  });

  it('succeeds on a repeated withdrawal rather than reporting a conflict', async () => {
    await revoke();
    const second = await revoke();

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ data: { status: 'revoked' } });
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
    admission.callerRole = 'admin';

    const response = await revoke();

    expect(response.statusCode).toBe(200);
  });

  // One literal for every caller outside this route's authority: each case
  // equals it, so no two refusals can differ by status, code, or message.
  it.each<[string, () => void, boolean]>(
    admission.mutationDenialCases(() => {
      apiKeys.revokeApiKey.mockResolvedValue({
        kind: 'organization_unavailable',
      });
    }),
  )('gives %s the same denial', async (_label, arrange, storeReached) => {
    arrange();

    const response = await revoke();

    expectAuthorizationDenial(response, {
      message: 'Organization API key revocation is forbidden',
      requestId: REQUEST_ID,
    });
    expect(apiKeys.revokeApiKey.mock.calls.length > 0).toBe(storeReached);
    // No refusal purges a cache entry: nothing was withdrawn.
    expect(cache.delete.mock.calls).toHaveLength(0);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await revoke({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.revokeApiKey.mock.calls).toHaveLength(0);
  });

  it('refuses a path segment carrying a NUL character before any lookup', async () => {
    // PostgreSQL cannot store or compare a NUL in text (SQLSTATE 22021), so
    // letting one through turns a caller's input into a 500.
    const response = await revoke(undefined, `${REVOKE_URL}%00`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    expect(apiKeys.revokeApiKey.mock.calls).toHaveLength(0);
  });

  it('reports an unknown key as not found', async () => {
    apiKeys.revokeApiKey.mockResolvedValue({ kind: 'key_not_found' });

    const response = await revoke();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(cache.delete.mock.calls).toHaveLength(0);
  });
});
