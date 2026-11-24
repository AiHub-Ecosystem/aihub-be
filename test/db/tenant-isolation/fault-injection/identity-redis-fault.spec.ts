import { Response } from 'undici';

import { once } from 'node:events';

import { numberReply } from '@/common/redis/number-reply';
import { RedisAuthRateLimiter } from '@/modules/auth/rate-limit/infrastructure/redis-auth-rate-limiter';
import { ApiKeyAuthenticator } from '@/modules/identity/api-keys/application/api-key-authenticator';
import { apiKeyLookupBudgetKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { PostgresApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { PostgresOrganizationIdentityConfigRepository } from '@/modules/identity/organization-identity-configuration/infrastructure/postgres-organization-identity-config.repository';
import { createPostgresIdentityClient } from '@/modules/identity/shared/infrastructure/postgres-identity.client';
import { RedisAuthFailureCounter } from '@/modules/identity/shared/infrastructure/redis-auth-failure-counter';
import type { RedisIdentityClient } from '@/modules/identity/shared/infrastructure/redis-identity-client';
import { RedisIdentityStore } from '@/modules/identity/shared/infrastructure/redis-identity.store';
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

import type {
  FaultMode,
  TcpFaultProxy,
} from '../../../support/tcp-fault-proxy';
import {
  redisThroughProxy,
  redisUnavailableCount,
  rejection,
  resetAndSeedTenants,
  timed,
} from './fault-targets';

// Identity Redis clients time out a command at 100 ms; the Postgres lookup
// behind them is local to the lane.
const FAIL_FAST_BOUND_MS = 1_500;
const IDENTITY_CACHE_HMAC_KEY = Buffer.alloc(32, 0x5a);

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

function redisIdentityClient(
  client: ReturnType<typeof createTenantIsolationRedis>,
): RedisIdentityClient {
  return {
    get: (key) => client.get(key),
    pttl: (key) => client.pttl(key),
    set: (key, value, mode, seconds, condition) =>
      condition === undefined
        ? client.set(key, value, mode, seconds)
        : client.set(key, value, mode, seconds, condition),
    del: (...keys) => client.del(...keys),
    incr: (key) => client.incr(key),
    eval: (script, numberOfKeys, ...args) =>
      client.eval(script, numberOfKeys, ...args).then(numberReply),
    expire: (key, seconds) => client.expire(key, seconds),
    quit: () => client.quit(),
  };
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
      const store = new RedisIdentityStore(
        proxiedRedisUrl,
        undefined,
        IDENTITY_CACHE_HMAC_KEY,
      );
      const warnings: Record<string, unknown>[] = [];
      const failures = new RedisAuthFailureCounter(proxiedRedisUrl, undefined, {
        warn: (fields: Record<string, unknown>) => warnings.push(fields),
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

        // The process-local failure count and lookup budget keep the cold
        // Redis path bounded; Postgres still refuses the unknown key.
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
          expect.objectContaining({
            event: 'redis_degraded',
            seam: 'auth_failure_counter',
            policy: 'using bounded process-local lookup and failure budgets',
          }),
        ]);
      } finally {
        await proxy.setMode('normal');
        await store.onModuleDestroy();
        await failures.onModuleDestroy();
      }
    });

    it('fails closed when Redis cannot reserve a verified assertion', async () => {
      await pool.query(
        `UPDATE organization_identity_configs
         SET jwks_url = $2, public_keys_jwks = NULL
         WHERE organization_id = $1`,
        [ORGANIZATION_A, 'https://tenant-a.example.test/jwks'],
      );
      const store = new RedisIdentityStore(
        proxiedRedisUrl,
        undefined,
        IDENTITY_CACHE_HMAC_KEY,
      );
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
          store,
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
        if (verified.result.status !== 'rejected') {
          throw new Error('assertion verification unexpectedly succeeded');
        }
        expect(verified.result.reason).toMatchObject({
          code: 'IDENTITY_PROVIDER_UNAVAILABLE',
          retryable: true,
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
  const store = new RedisIdentityStore(
    proxiedRedisUrl,
    undefined,
    IDENTITY_CACHE_HMAC_KEY,
  );
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

it('shares an exhausted uncached API-key budget across Redis clients', async () => {
  const budgetKey = apiKeyLookupBudgetKey();
  const firstRedis = createTenantIsolationRedis();
  const secondRedis = createTenantIsolationRedis();
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    warn: (fields: Record<string, unknown>) => warnings.push(fields),
    log: () => undefined,
  };
  const first = new RedisAuthFailureCounter(
    '',
    redisIdentityClient(firstRedis),
    logger,
  );
  const second = new RedisAuthFailureCounter(
    '',
    redisIdentityClient(secondRedis),
    logger,
  );

  try {
    await Promise.all(
      [firstRedis, secondRedis].map(async (client) => {
        if (client.status !== 'ready') await once(client, 'ready');
        await client.ping();
      }),
    );
    await raw.del(budgetKey);
    await expect(first.consumeUncachedLookup()).resolves.toEqual({
      allowed: true,
    });
    const updatedAt = String(Date.now() + 60 * 60 * 1_000);
    await raw.hset(budgetKey, 'tokens', '0', 'updated_at', updatedAt);
    await expect(raw.hgetall(budgetKey)).resolves.toEqual({
      tokens: '0',
      updated_at: updatedAt,
    });

    const decision = await second.consumeUncachedLookup();
    expect(warnings).toEqual([]);
    expect(decision).toEqual({
      allowed: false,
      retryAfterMs: 10,
    });
  } finally {
    await raw.del(budgetKey);
    await first.onModuleDestroy();
    await second.onModuleDestroy();
  }
});
