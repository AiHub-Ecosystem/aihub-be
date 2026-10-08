import Redis from 'ioredis';
import {
  type CryptoKey,
  type KeyObject,
  SignJWT,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { ulid } from 'ulid';

import type { RedisGatewayClient } from '@/modules/gateway/infrastructure/redis-gateway.client';
import { ORGANIZATION_INVITATION_CREATE_OPERATION } from '@/modules/idempotency/application/idempotency-operation';
import type { GeneratedApiKey } from '@/modules/identity/domain/api-key';
import type { PublicJsonWebKeySet } from '@/modules/identity/organization-identity-configuration/application/organization-identity-config-repository.port';
import type { RedisIdentityClient } from '@/modules/identity/shared/infrastructure/redis-identity.store';

export const TEST_NOW = new Date('2026-09-15T12:00:00.000Z');
export const ORGANIZATION_A = 'org_tenant_a';
export const ORGANIZATION_B = 'org_tenant_b';
export const ACTOR_ID = `usr_${ulid(TEST_NOW.getTime())}`;
export const SHARED_SUBJECT = 'shared-subject';
export const SHARED_IDEMPOTENCY_KEY = 'shared-idempotency-key';
export const SHARED_OPERATION = ORGANIZATION_INVITATION_CREATE_OPERATION;
export const SHARED_MONTH = '2026-09';
export const SHARED_KEY_PREFIX = 'aihub_sk_shared';

export interface TenantIdentity {
  readonly issuer: string;
  readonly keyId: string;
  readonly jwks: PublicJsonWebKeySet;
  readonly privateKey: CryptoKey | KeyObject;
}

export interface TenantFixture {
  readonly id: string;
  readonly apiKey: GeneratedApiKey;
  readonly identity: TenantIdentity;
}

export interface TenantIsolationFixture {
  readonly actorId: string;
  readonly organizationA: TenantFixture;
  readonly organizationB: TenantFixture;
}

export interface TenantIsolationRedisClients {
  readonly raw: Redis;
  readonly gateway: RedisGatewayClient;
  readonly identity: RedisIdentityClient;
}

export async function createTenantIdentity(
  issuer: string,
  keyId: string,
): Promise<TenantIdentity> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    issuer,
    keyId,
    jwks: {
      keys: [{ ...jwk, kid: keyId, alg: 'RS256', use: 'sig' }],
    },
    privateKey,
  };
}

export async function signUserAssertion(
  identity: TenantIdentity,
  now: Date = TEST_NOW,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 10;
  const expiresAt = issuedAt + 300;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: identity.keyId })
    .setIssuer(identity.issuer)
    .setAudience('aihub')
    .setSubject(SHARED_SUBJECT)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti('jti_tenant_isolation')
    .sign(identity.privateKey);
}

function tenantIsolationRedisUrl(): string {
  const url = new URL(
    process.env.TENANT_ISOLATION_REDIS_URL?.trim() ||
      'redis://127.0.0.1:6379/15',
  );
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
    url.pathname !== '/15' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      'TENANT_ISOLATION_REDIS_URL must use a loopback Redis database 15 without credentials',
    );
  }

  return url.toString();
}

export function createTenantIsolationRedis(): Redis {
  const url = tenantIsolationRedisUrl();
  const redis = new Redis(url, {
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => undefined);
  return redis;
}

export function createTenantIsolationRedisClients(): TenantIsolationRedisClients {
  const raw = createTenantIsolationRedis();
  const gateway: RedisGatewayClient = {
    ping: () => raw.ping(),
    get: (key) => raw.get(key),
    set: (key, value, mode, seconds) => raw.set(key, value, mode, seconds),
    incr: (key) => raw.incr(key),
    expire: (key, seconds) => raw.expire(key, seconds),
    eval: async (script, numberOfKeys, ...args) => {
      const result = await raw.eval(script, numberOfKeys, ...args);
      if (typeof result !== 'number') {
        throw new Error('Redis eval result is invalid');
      }
      return result;
    },
    zrem: (key, member) => raw.zrem(key, member),
    quit: () => raw.quit(),
  };
  const identity: RedisIdentityClient = {
    get: (key) => raw.get(key),
    set: (key, value, mode, seconds, condition) =>
      condition === undefined
        ? raw.set(key, value, mode, seconds)
        : raw.set(key, value, mode, seconds, condition),
    del: (...keys) => raw.del(...keys),
    incr: (key) => raw.incr(key),
    expire: (key, seconds) => raw.expire(key, seconds),
    quit: () => raw.quit(),
  };
  return { raw, gateway, identity };
}

export async function resetTenantIsolation(
  pool: { query(text: string): Promise<unknown> },
  redis: Redis,
): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      organization_identity_configs,
      organization_audit_events,
      api_keys,
      organization_invitations,
      organization_members,
      auth_identities,
      user_accounts,
      idempotency_records,
      usage_records,
      organizations
    RESTART IDENTITY CASCADE
  `);
  await redis.flushdb();
}

export async function seedTenantIsolation(
  pool: {
    query(text: string, values?: readonly unknown[]): Promise<unknown>;
  },
  organizationAIdentity: TenantIdentity,
  organizationBIdentity: TenantIdentity,
  apiKeyA: GeneratedApiKey,
  apiKeyB: GeneratedApiKey,
): Promise<TenantIsolationFixture> {
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [ACTOR_ID, 'tenant-isolation-actor', TEST_NOW],
  );
  await pool.query(
    `INSERT INTO organizations
       (id, name, status, entitlements, rate_limit_rpm, max_concurrent,
        monthly_request_quota, hard_stop_on_quota, created_at, updated_at)
     VALUES
       ($1, 'Tenant A', 'active', ARRAY['writing'], 60, 1, 1, true, $2, $2),
       ($3, 'Tenant B', 'active', ARRAY['speaking'], 60, 1, 1, true, $2, $2)`,
    [ORGANIZATION_A, TEST_NOW, ORGANIZATION_B],
  );
  await pool.query(
    `INSERT INTO organization_members
       (organization_id, user_account_id, role, status)
     VALUES ($1, $3, 'owner', 'active'), ($2, $3, 'owner', 'active')`,
    [ORGANIZATION_A, ORGANIZATION_B, ACTOR_ID],
  );
  await pool.query(
    `INSERT INTO organization_identity_configs
       (organization_id, issuer, jwks_url, public_keys_jwks,
        allowed_algorithms, max_assertion_ttl_seconds, status)
     VALUES ($1, $3, NULL, $4, ARRAY['RS256'], 300, 'active'),
            ($2, $5, NULL, $6, ARRAY['RS256'], 300, 'active')`,
    [
      ORGANIZATION_A,
      ORGANIZATION_B,
      organizationAIdentity.issuer,
      JSON.stringify(organizationAIdentity.jwks),
      organizationBIdentity.issuer,
      JSON.stringify(organizationBIdentity.jwks),
    ],
  );
  await pool.query(
    `INSERT INTO api_keys
       (id, organization_id, key_hash, key_prefix, name, scopes,
        allowed_environments, status, created_at)
     VALUES ($1, $2, decode($3, 'hex'), $4, 'shared-key', ARRAY['writing.grade'],
             ARRAY['production'], 'active', $5),
            ($6, $7, decode($8, 'hex'), $4, 'shared-key', ARRAY['speaking.grade'],
             ARRAY['production'], 'active', $5)`,
    [
      apiKeyA.id,
      ORGANIZATION_A,
      apiKeyA.hash,
      SHARED_KEY_PREFIX,
      TEST_NOW,
      apiKeyB.id,
      ORGANIZATION_B,
      apiKeyB.hash,
    ],
  );
  return {
    actorId: ACTOR_ID,
    organizationA: {
      id: ORGANIZATION_A,
      apiKey: apiKeyA,
      identity: organizationAIdentity,
    },
    organizationB: {
      id: ORGANIZATION_B,
      apiKey: apiKeyB,
      identity: organizationBIdentity,
    },
  };
}
