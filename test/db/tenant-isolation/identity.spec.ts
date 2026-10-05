import { Response } from 'undici';

import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { ApiKeyAuthenticator } from '@/modules/identity/application/api-key-authenticator';
import { UserAssertionVerifier } from '@/modules/identity/application/user-assertion-verifier';
import { UserIdentityResolver } from '@/modules/identity/application/user-identity-resolver';
import { hashApiKey } from '@/modules/identity/domain/api-key';
import { JoseUserAssertionCrypto } from '@/modules/identity/infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from '@/modules/identity/infrastructure/jwks-key-provider';
import { PostgresApiKeyRepository } from '@/modules/identity/infrastructure/postgres-api-key.repository';
import { createIdentityDrizzleClient } from '@/modules/identity/infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from '@/modules/identity/infrastructure/postgres-organization-identity-config.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from '@/modules/identity/infrastructure/redis-identity.store';

import { createTestPool, testDatabaseUrl } from '../database';

import {
  ORGANIZATION_A,
  ORGANIZATION_B,
  TEST_NOW,
  type TenantIsolationFixture,
  type TenantIsolationRedisClients,
  createTenantIdentity,
  createTenantIsolationRedisClients,
  resetTenantIsolation,
  seedTenantIsolation,
  signUserAssertion,
} from './fixtures';

let pool: ReturnType<typeof createTestPool>;
let redisClients: TenantIsolationRedisClients;
let fixture: TenantIsolationFixture;
let identityClient: ReturnType<typeof createIdentityDrizzleClient>;
let configRepository: PostgresOrganizationIdentityConfigRepository;
let identityStore: RedisIdentityStore;
let failureCounter: RedisAuthFailureCounter;
let authenticator: ApiKeyAuthenticator;

function nowSeconds(): number {
  return Math.floor(TEST_NOW.getTime() / 1_000);
}

beforeAll(() => {
  pool = createTestPool();
  redisClients = createTenantIsolationRedisClients();
  identityClient = createIdentityDrizzleClient(testDatabaseUrl());
  configRepository = new PostgresOrganizationIdentityConfigRepository(
    identityClient,
  );
  identityStore = new RedisIdentityStore('', redisClients.identity);
  failureCounter = new RedisAuthFailureCounter('', redisClients.identity);
  authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(identityClient),
    identityStore,
    failureCounter,
    () => TEST_NOW,
  );
});

beforeEach(async () => {
  await resetTenantIsolation(pool, redisClients.raw);
  fixture = await seedTenantIsolation(
    pool,
    await createTenantIdentity(
      'https://tenant-a.example.test',
      'tenant-shared-key',
    ),
    await createTenantIdentity(
      'https://tenant-b.example.test',
      'tenant-shared-key',
    ),
    generateOrganizationApiKey(TEST_NOW),
    generateOrganizationApiKey(TEST_NOW),
  );
});

afterAll(async () => {
  await identityClient?.close();
  await pool?.end();
  await redisClients?.raw.quit();
});

describe('tenant isolation for identity boundaries', () => {
  it('keeps API-key ownership, entitlements, and cache state with its Organization', async () => {
    const first = await authenticator.authenticate({
      value: fixture.organizationA.apiKey.raw,
      environment: 'production',
      clientIp: '127.0.0.1',
    });
    const warm = await authenticator.authenticate({
      value: fixture.organizationA.apiKey.raw,
      environment: 'production',
      clientIp: '127.0.0.1',
    });

    expect(first).toMatchObject({
      organizationId: ORGANIZATION_A,
      apiKeyId: fixture.organizationA.apiKey.id,
      scopes: ['writing.grade'],
      monthlyRequestQuota: 1,
    });
    expect(warm).toEqual(first);
    await expect(
      redisClients.raw.get(
        `aihub:v1:key:${hashApiKey(fixture.organizationA.apiKey.raw)}`,
      ),
    ).resolves.toEqual(expect.stringContaining(ORGANIZATION_A));
    await expect(
      redisClients.raw.get(
        `aihub:v1:key:${hashApiKey(fixture.organizationB.apiKey.raw)}`,
      ),
    ).resolves.toBeNull();
  });

  it('does not resolve another Organization configuration after authenticating this API key', async () => {
    const authenticated = await authenticator.authenticate({
      value: fixture.organizationA.apiKey.raw,
      environment: 'production',
      clientIp: '127.0.0.1',
    });
    const assertion = await signUserAssertion(fixture.organizationB.identity);
    const verifier = new UserIdentityResolver(
      configRepository,
      new UserAssertionVerifier(
        new JwksKeyProvider(identityStore, undefined, undefined, () =>
          TEST_NOW.getTime(),
        ),
        new JoseUserAssertionCrypto(),
        nowSeconds,
      ),
    );

    expect(authenticated.organizationId).toBe(ORGANIZATION_A);
    await expect(
      verifier.resolve({
        value: assertion,
        organizationId: authenticated.organizationId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  it('treats a disabled identity configuration as declared mode for that Organization only', async () => {
    await pool.query(
      `UPDATE organization_identity_configs
       SET status = 'disabled'
       WHERE organization_id = $1`,
      [ORGANIZATION_A],
    );
    const resolver = new UserIdentityResolver(
      configRepository,
      new UserAssertionVerifier(
        new JwksKeyProvider(identityStore, undefined, undefined, () =>
          TEST_NOW.getTime(),
        ),
        new JoseUserAssertionCrypto(),
        nowSeconds,
      ),
    );

    await expect(
      resolver.resolve({
        value: 'student_456',
        organizationId: ORGANIZATION_A,
      }),
    ).resolves.toEqual({
      userId: 'student_456',
      organizationId: ORGANIZATION_A,
      scopes: [],
    });
    await expect(
      resolver.resolve({
        value: 'student_456',
        organizationId: ORGANIZATION_B,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
  });

  it('keeps colliding assertion subjects in their Organization JWKS cache namespace', async () => {
    await pool.query(
      `UPDATE organization_identity_configs
       SET jwks_url = $2, public_keys_jwks = NULL
       WHERE organization_id = $1`,
      [ORGANIZATION_A, 'https://tenant-a.example.test/jwks'],
    );
    await pool.query(
      `UPDATE organization_identity_configs
       SET jwks_url = $2, public_keys_jwks = NULL
       WHERE organization_id = $1`,
      [ORGANIZATION_B, 'https://tenant-b.example.test/jwks'],
    );

    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      fetched.push(url);
      const organization = url.includes('tenant-a')
        ? fixture.organizationA
        : fixture.organizationB;
      return new Response(JSON.stringify(organization.identity.jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const provider = new JwksKeyProvider(
      identityStore,
      fetcher,
      lookup,
      Date.now,
    );
    const verifier = new UserIdentityResolver(
      configRepository,
      new UserAssertionVerifier(
        provider,
        new JoseUserAssertionCrypto(),
        nowSeconds,
      ),
    );
    const assertionA = await signUserAssertion(fixture.organizationA.identity);
    const assertionB = await signUserAssertion(fixture.organizationB.identity);

    await expect(
      verifier.resolve({
        value: assertionA,
        organizationId: ORGANIZATION_A,
      }),
    ).resolves.toEqual({
      userId: 'shared-subject',
      organizationId: ORGANIZATION_A,
      scopes: [],
    });
    await expect(
      verifier.resolve({
        value: assertionB,
        organizationId: ORGANIZATION_A,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
    await expect(
      verifier.resolve({
        value: assertionB,
        organizationId: ORGANIZATION_B,
      }),
    ).resolves.toEqual({
      userId: 'shared-subject',
      organizationId: ORGANIZATION_B,
      scopes: [],
    });
    await verifier.resolve({
      value: assertionB,
      organizationId: ORGANIZATION_B,
    });

    expect(fetched).toEqual([
      'https://tenant-a.example.test/jwks',
      'https://tenant-b.example.test/jwks',
    ]);
    const organizationAKeys = await redisClients.raw.keys(
      `aihub:v1:jwks:${ORGANIZATION_A}:*`,
    );
    const organizationBKeys = await redisClients.raw.keys(
      `aihub:v1:jwks:${ORGANIZATION_B}:*`,
    );
    expect(organizationAKeys.length).toBeGreaterThan(0);
    expect(organizationBKeys.length).toBeGreaterThan(0);
    expect(organizationAKeys).not.toEqual(organizationBKeys);
  });
});
