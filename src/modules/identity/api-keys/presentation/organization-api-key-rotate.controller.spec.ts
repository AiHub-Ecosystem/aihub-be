import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Value } from '@sinclair/typebox/value';

import { AppModule } from '@/app.module';
import { OrganizationApiKeySecretResponseSchema } from '@/contracts/organization/api-key';
import {
  API_KEY_CACHE,
  type ApiKeyCachePort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  ORGANIZATION_API_KEY,
  type OrganizationApiKeyPort,
  type RotateOrganizationApiKeyRecordInput,
} from '@/modules/identity/api-keys/application/organization-api-key.port';
import { RotateOrganizationApiKeyCommand } from '@/modules/identity/api-keys/presentation/organization-api-key.cqrs';
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
const RETIRED_KEY_ID = 'ak_01J00000000000000000000001';
const ROTATE_URL = `/v1/organizations/${ORGANIZATION_ID}/api-keys/${RETIRED_KEY_ID}/rotate`;
const CREATED_AT = new Date('2026-09-21T10:00:00.000Z');
const INHERITED_EXPIRY = new Date('2027-01-01T00:00:00.000Z');
const RETIRED_HASH = 'a'.repeat(64);

function rotated() {
  return {
    kind: 'rotated' as const,
    retiredKeyHash: RETIRED_HASH,
    name: 'Prod backend',
    scopes: ['writing.grade'] as readonly string[],
    allowedEnvironments: ['production'] as readonly string[],
    expiresAt: INHERITED_EXPIRY,
    createdAt: CREATED_AT,
    createdByUsername: null,
    lastRotatedByUsername: 'rotator',
  };
}

describe('Organization API key rotation HTTP flow', () => {
  let app: NestFastifyApplication;
  let apiKeys: jest.Mocked<OrganizationApiKeyPort>;
  let cache: jest.Mocked<ApiKeyCachePort>;
  const admission = new OrganizationAdmissionHarness();

  beforeAll(async () => {
    apiKeys = createMockOrganizationApiKeyPort({
      rotateApiKey: jest.fn().mockResolvedValue(rotated()),
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

    app = await initOrganizationTestApp(moduleRef, {
      requestId: REQUEST_ID,
      securityHeaders: true,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    admission.reset();
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

  function secretBody(response: { json(): unknown }) {
    return Value.Parse(OrganizationApiKeySecretResponseSchema, response.json());
  }

  it('returns the raw replacement once with the inherited key metadata', async () => {
    const execute = jest.spyOn(app.get(CommandBus), 'execute');
    const response = await rotate();

    expect(execute).toHaveBeenCalledWith(
      expect.any(RotateOrganizationApiKeyCommand),
    );
    expect(response.statusCode).toBe(200);
    const body = secretBody(response);
    expect(body.data).toMatchObject({
      name: 'Prod backend',
      scopes: ['writing.grade'],
      allowed_environments: ['production'],
      status: 'active',
      expires_at: INHERITED_EXPIRY.toISOString(),
      last_used_at: null,
      created_at: CREATED_AT.toISOString(),
      created_by: null,
      last_rotated_by: 'rotator',
    });
    expect(body.data.api_key).toMatch(/^aihub_sk_[A-Za-z0-9]{43}$/);
    expect(body.data.id).toMatch(/^ak_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.data.key_prefix).toMatch(/^aihub_sk_[A-Za-z0-9]{6}$/);
    expect(body.meta.request_id).toBe(REQUEST_ID);
  });

  it('returns a body the published response contract accepts', async () => {
    const response = await rotate();

    expect(secretBody(response).data.api_key).toMatch(/^aihub_sk_/);
  });

  it('gives the replacement its own identifier, not the retired one', async () => {
    const response = await rotate();

    const body = secretBody(response);
    expect(body.data.id).not.toBe(RETIRED_KEY_ID);
    expect(rotateCall().apiKeyId).toBe(RETIRED_KEY_ID);
    expect(rotateCall().replacementId).toBe(body.data.id);
  });

  it('marks the credential response uncacheable', async () => {
    const response = await rotate();

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('purges the identity cache entry of the retired key', async () => {
    await rotate();

    expect(cache.delete.mock.calls).toContainEqual([
      RETIRED_HASH,
      'api_key_cache_invalidation_rotate',
    ]);
  });

  it('still returns the replacement when the cache purge fails', async () => {
    cache.delete.mockRejectedValue(new Error('redis is unreachable'));

    const response = await rotate();

    // The durable rotation is already committed. Failing the request here
    // would withhold the only copy of a credential the caller now has to use,
    // while the old one is already revoked.
    expect(response.statusCode).toBe(200);
    expect(secretBody(response).data.api_key).toMatch(
      /^aihub_sk_[A-Za-z0-9]{43}$/,
    );
  });

  it('never discloses the retired key hash', async () => {
    const response = await rotate();

    expect(response.body).not.toContain(RETIRED_HASH);
  });

  it('persists only the replacement hash, never its raw credential', async () => {
    const response = await rotate();

    const persisted = rotateCall();
    const rawKey = secretBody(response).data.api_key;
    expect(persisted.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(rawKey);
    expect(persisted.keyPrefix).toBe(rawKey.slice(0, 15));
    expect(persisted.organizationId).toBe(ORGANIZATION_ID);
  });

  it('rotates for an organization admin', async () => {
    admission.callerRole = 'admin';

    const response = await rotate();

    expect(response.statusCode).toBe(200);
  });

  // One literal for every caller outside this route's authority: each case
  // equals it, so no two refusals can differ by status, code, or message.
  it.each<[string, () => void, boolean]>(
    admission.mutationDenialCases(() => {
      apiKeys.rotateApiKey.mockResolvedValue({
        kind: 'organization_unavailable',
      });
    }),
  )('gives %s the same denial', async (_label, arrange, storeReached) => {
    arrange();

    const response = await rotate();

    expectAuthorizationDenial(response, {
      message: 'Organization API key rotation is forbidden',
      requestId: REQUEST_ID,
    });
    expect(apiKeys.rotateApiKey.mock.calls.length > 0).toBe(storeReached);
    // No refusal purges a cache entry: nothing was withdrawn.
    expect(cache.delete.mock.calls).toHaveLength(0);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await rotate({});

    expect(response.statusCode).toBe(401);
    expect(apiKeys.rotateApiKey.mock.calls).toHaveLength(0);
  });

  it('reports an unknown key as not found', async () => {
    apiKeys.rotateApiKey.mockResolvedValue({ kind: 'key_not_found' });

    const response = await rotate();

    expect(response.statusCode).toBe(404);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(cache.delete.mock.calls).toHaveLength(0);
  });

  it('reports a revoked or expired key as forbidden', async () => {
    apiKeys.rotateApiKey.mockResolvedValue({ kind: 'key_not_rotatable' });

    const response = await rotate();

    expect(response.statusCode).toBe(403);
    expect(response.json<unknown>()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(cache.delete.mock.calls).toHaveLength(0);
  });

  it('issues a distinct replacement on every rotation', async () => {
    const first = await rotate();
    const second = await rotate();

    expect(secretBody(first).data.api_key).not.toBe(
      secretBody(second).data.api_key,
    );
    expect(secretBody(first).data.id).not.toBe(secretBody(second).data.id);
  });
});
