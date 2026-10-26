import { Response } from 'undici';

import { RedisAuthRateLimiter } from '@/modules/auth/rate-limit/infrastructure/redis-auth-rate-limiter';
import { ApiKeyAuthenticator } from '@/modules/identity/api-keys/application/api-key-authenticator';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { PostgresApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { PostgresOrganizationIdentityConfigRepository } from '@/modules/identity/organization-identity-configuration/infrastructure/postgres-organization-identity-config.repository';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from '@/modules/identity/shared/infrastructure/redis-identity.store';
import { UserAssertionVerifier } from '@/modules/identity/user-assertions/application/user-assertion-verifier';
import { UserIdentityResolver } from '@/modules/identity/user-assertions/application/user-identity-resolver';
import { JoseUserAssertionCrypto } from '@/modules/identity/user-assertions/infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from '@/modules/identity/user-assertions/infrastructure/jwks-key-provider';

import { createTestPool, testDatabaseUrl } from '../../shared/database';
import {
  ORGANIZATION_A,
  ORGANIZATION_B,
  TEST_NOW,
  type TenantIsolationFixture,
  createTenantIsolationRedis,
  signUserAssertion,
} from '../fixtures';

import {
  redisThroughProxy,
  redisUnavailableCount,
  rejection,
  resetAndSeedTenants,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// Identity Redis clients time out a command at 100 ms; the Postgres lookup
// behind them is local to the lane.
const FAIL_FAST_BOUND_MS = 1_500;

let pool: ReturnType<typeof createTestPool>;
let identityClient: ReturnType<typeof createPostgresIdentityClient>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let proxy: TcpFaultProxy;
let proxiedRedisUrl: string;
let fixture: TenantIsolationFixture;

function nowSeconds(): number {
  return Math.floor(TEST_NOW.getTime() / 1_000);
}

function credential(value: string) {
  return { value, environment: 'production', clientIp: '198.51.100.7' };
}

beforeAll(async () => {
  pool = createTestPool();
  identityClient = createPostgresIdentityClient(testDatabaseUrl());
  raw = createTenantIsolationRedis();
  const target = await redisThroughProxy();
  proxy = target.proxy;
  proxiedRedisUrl = target.url;
});

beforeEach(async () => {
  await proxy.setMode('normal');
  fixture = await resetAndSeedTenants(pool, raw);
});

afterAll(async () => {
  await proxy.close();
  await identityClient.close();
  await pool.end();
  await raw.quit();
});

describe.each<FaultMode>(['refuse', 'hang', 'slow'])(
  'identity while Redis is %s',
  (mode) => {
    // Each test builds fresh stores so no process-local cache answers for Redis.
    it('authenticates from Postgres and never grants an unknown key', async () => {
      const store = new RedisIdentityStore(proxiedRedisUrl);
      const warnings: string[] = [];
      const failures = new RedisAuthFailureCounter(proxiedRedisUrl, undefined, {
        warn: (message: string) => warnings.push(message),
        log: () => undefined,
      });
      const authenticator = new ApiKeyAuthenticator(
        new PostgresApiKeyRepository(identityClient),
        store,
        failures,
        () => TEST_NOW,
      );
      const before = {
        cache: await redisUnavailableCount('api_key_cache'),
        counter: await redisUnavailableCount('auth_failure_counter'),
      };

      try {
        await proxy.setMode(mode);
        const valid = await timed(() =>
          authenticator.authenticate(
            credential(fixture.organizationA.apiKey.raw),
          ),
        );
        if (valid.result.status !== 'fulfilled') throw valid.result.reason;
        expect(valid.result.value).toMatchObject({
          organizationId: ORGANIZATION_A,
          apiKeyId: fixture.organizationA.apiKey.id,
          scopes: ['writing.grade'],
        });
        expect(valid.ms).toBeLessThan(FAIL_FAST_BOUND_MS);

        // Repeated failures cannot be counted, so brute-force protection
        // allows each attempt through to Postgres, which still refuses it.
        const unknownKey = generateOrganizationApiKey(TEST_NOW).raw;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const refused = await timed(() =>
            authenticator.authenticate(credential(unknownKey)),
          );
          expect(rejection(refused.result)).toMatchObject({
            code: 'UNAUTHORIZED',
            httpStatus: 401,
          });
          expect(refused.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
        }

        expect(await redisUnavailableCount('api_key_cache')).toBeGreaterThan(
          before.cache,
        );
        expect(
          await redisUnavailableCount('auth_failure_counter'),
        ).toBeGreaterThan(before.counter);
        expect(warnings).toEqual([
          expect.stringContaining('brute-force protection is failing open'),
        ]);
      } finally {
        await proxy.setMode('normal');
        await store.onModuleDestroy();
        await failures.onModuleDestroy();
      }
    });

    it('verifies a signed assertion against keys fetched from the issuer', async () => {
      await pool.query(
        `UPDATE organization_identity_configs
         SET jwks_url = $2, public_keys_jwks = NULL
         WHERE organization_id = $1`,
        [ORGANIZATION_A, 'https://tenant-a.example.test/jwks'],
      );
      const store = new RedisIdentityStore(proxiedRedisUrl);
      const fetched: string[] = [];
      const provider = new JwksKeyProvider(
        store,
        async (url: string) => {
          fetched.push(url);
          return new Response(
            JSON.stringify(fixture.organizationA.identity.jwks),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
        () => ({
          resolve4: async () => ['8.8.8.8'],
          resolve6: async () => [],
          cancel: () => undefined,
        }),
        Date.now,
      );
      const resolver = new UserIdentityResolver(
        new PostgresOrganizationIdentityConfigRepository(identityClient),
        new UserAssertionVerifier(
          provider,
          new JoseUserAssertionCrypto(),
          nowSeconds,
        ),
      );
      const before = await redisUnavailableCount('jwks_cache');

      try {
        await proxy.setMode(mode);
        const verified = await timed(async () =>
          resolver.resolve({
            value: await signUserAssertion(fixture.organizationA.identity),
            organizationId: ORGANIZATION_A,
          }),
        );
        if (verified.result.status !== 'fulfilled') {
          throw verified.result.reason;
        }
        expect(verified.result.value).toMatchObject({
          organizationId: ORGANIZATION_A,
          mode: 'signed_assertion',
        });
        expect(verified.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
        expect(fetched).toEqual(['https://tenant-a.example.test/jwks']);

        // Another Organization's assertion is still refused for A.
        await expect(
          resolver.resolve({
            value: await signUserAssertion(fixture.organizationB.identity),
            organizationId: ORGANIZATION_A,
          }),
        ).rejects.toMatchObject({ code: 'INVALID_USER_IDENTITY' });
        expect(await redisUnavailableCount('jwks_cache')).toBeGreaterThan(
          before,
        );
      } finally {
        await proxy.setMode('normal');
        await store.onModuleDestroy();
      }
    });

    it('keeps local-auth rate limits at a process-local ceiling', async () => {
      const limiter = new RedisAuthRateLimiter(proxiedRedisUrl);
      const before = await redisUnavailableCount('auth_rate_limit');
      const input = {
        scope: 'login_email' as const,
        key: `fault-${mode}@example.test`,
        limit: 2,
        windowMs: 60_000,
      };

      try {
        await proxy.setMode(mode);
        const decisions = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const call = await timed(() => limiter.consume(input));
          expect(call.ms).toBeLessThan(FAIL_FAST_BOUND_MS);
          if (call.result.status !== 'fulfilled') throw call.result.reason;
          decisions.push(call.result.value.allowed);
        }
        expect(decisions).toEqual([true, true, false]);
        expect(await redisUnavailableCount('auth_rate_limit')).toBeGreaterThan(
          before,
        );
      } finally {
        await proxy.setMode('normal');
        await limiter.onModuleDestroy();
      }
    });
  },
);

it('uses organization B only for B while Redis is refused', async () => {
  // Authorization data comes from Postgres per key, so an outage cannot make
  // one Organization's key resolve to another.
  const store = new RedisIdentityStore(proxiedRedisUrl);
  const failures = new RedisAuthFailureCounter(proxiedRedisUrl, undefined, {
    warn: () => undefined,
    log: () => undefined,
  });
  const authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(identityClient),
    store,
    failures,
    () => TEST_NOW,
  );
  await proxy.setMode('refuse');
  try {
    await expect(
      authenticator.authenticate(credential(fixture.organizationB.apiKey.raw)),
    ).resolves.toMatchObject({ organizationId: ORGANIZATION_B });
  } finally {
    await proxy.setMode('normal');
    await store.onModuleDestroy();
    await failures.onModuleDestroy();
  }
});
