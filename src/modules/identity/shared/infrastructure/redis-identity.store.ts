import { apiKeyRecordFromRow } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';

import {
  type ApiKeyCacheInvalidationSeam,
  recordRedisUnavailable,
} from '@/common/observability/redis-unavailable-metric';
import {
  type ApiKeyCachePort,
  type ApiKeyRecord,
  apiKeyCacheKey,
  apiKeyCacheMissKey,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { parsePublicJsonWebKeySet } from '@/modules/identity/domain/organization-identity-config';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksCacheSnapshot,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import {
  signIdentityCacheEntry,
  verifyIdentityCacheEntry,
} from './identity-cache-envelope';
import { recordIdentityCacheIntegrityRejection } from './identity-cache-integrity-metric';
import { putBounded, shortenedTtl } from './local-cache-policy';
import {
  type RedisIdentityClient,
  connectRedisIdentityClient,
} from './redis-identity-client';

function jwksKey(
  organizationId: string,
  configVersion: string,
  generation: string,
): string {
  return `aihub:v1:jwks:${organizationId}:${configVersion}:${generation}`;
}

function jwksGenerationKey(organizationId: string): string {
  return `aihub:v1:jwks-generation:${organizationId}`;
}

function jwksRefreshKey(organizationId: string): string {
  return `aihub:v1:jwks-refresh:${organizationId}`;
}

const API_KEY_CACHE_POSITIVE_TTL_SECONDS = 60;
const API_KEY_CACHE_NEGATIVE_TTL_SECONDS = 30;
const MAX_LOCAL_API_KEY_ENTRIES = 1_024;
const MAX_LOCAL_JWKS_ENTRIES = 128;

interface LocalApiKeyEntry {
  readonly value: ApiKeyRecord | null;
  readonly expiresAt: number;
}

interface LocalJwksEntry {
  readonly generation: string;
  readonly entry: JwksCacheEntry;
  readonly expiresAt: number;
}

interface ApiKeyCacheData {
  readonly type: 'record' | 'miss';
  readonly freshUntil: number;
  readonly record?: unknown;
}

function parseApiKeyCacheData(value: unknown): ApiKeyCacheData | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  if (
    (data['type'] !== 'record' && data['type'] !== 'miss') ||
    typeof data['freshUntil'] !== 'number' ||
    !Number.isSafeInteger(data['freshUntil']) ||
    (data['type'] === 'record' && data['record'] === undefined)
  ) {
    return undefined;
  }
  return {
    type: data['type'],
    freshUntil: data['freshUntil'],
    record: data['record'],
  };
}

function localJwksKey(organizationId: string, configVersion: string): string {
  return JSON.stringify([organizationId, configVersion]);
}

function parseJwksCacheEntry(value: unknown): JwksCacheEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const jwks = parsePublicJsonWebKeySet(record['jwks']);
  const freshUntil = record['freshUntil'];
  const staleUntil = record['staleUntil'];
  if (
    jwks === undefined ||
    typeof freshUntil !== 'number' ||
    !Number.isSafeInteger(freshUntil) ||
    typeof staleUntil !== 'number' ||
    !Number.isSafeInteger(staleUntil) ||
    staleUntil <= freshUntil
  ) {
    return undefined;
  }

  return { jwks, freshUntil, staleUntil };
}

export class RedisIdentityStore implements ApiKeyCachePort, JwksCachePort {
  private readonly client: RedisIdentityClient | undefined;
  private readonly hmacKey: Buffer | undefined;
  private readonly localApiKeys = new Map<string, LocalApiKeyEntry>();
  private readonly localJwks = new Map<string, LocalJwksEntry>();

  constructor(url: string, client?: RedisIdentityClient, hmacKey?: Buffer) {
    this.client = client ?? connectRedisIdentityClient(url);
    this.hmacKey = hmacKey;
  }

  async get(hashHex: string): Promise<ApiKeyRecord | null | undefined> {
    const local = this.localApiKeys.get(hashHex);
    if (local !== undefined) {
      if (local.expiresAt > performance.now()) return local.value;
      this.localApiKeys.delete(hashHex);
    }

    if (this.client === undefined || this.hmacKey === undefined) {
      return undefined;
    }

    try {
      const cacheKey = apiKeyCacheKey(hashHex);
      const serialized = await this.client.get(cacheKey);
      if (serialized !== null) {
        const verification = verifyIdentityCacheEntry({
          key: this.hmacKey as Buffer,
          kind: 'api_key',
          redisKey: cacheKey,
          serialized,
        });
        if (!verification.authenticated) {
          recordIdentityCacheIntegrityRejection('api_key');
          await this.client.del(cacheKey);
          return undefined;
        }
        const data = parseApiKeyCacheData(verification.data);
        if (data === undefined) {
          await this.client.del(cacheKey);
          return undefined;
        }
        const record =
          data['type'] === 'record' && data['freshUntil'] > Date.now()
            ? apiKeyRecordFromRow(data['record'])
            : undefined;
        if (record === undefined) {
          await this.client.del(cacheKey);
          return undefined;
        }
        const lookupStartedAt = performance.now();
        const remainingMs = Math.min(
          await this.client.pttl(cacheKey),
          data['freshUntil'] - Date.now(),
        );
        if (remainingMs <= 0) {
          await this.client.del(cacheKey);
          return undefined;
        }
        this.rememberApiKey(hashHex, record, lookupStartedAt + remainingMs);
        return record;
      }

      const missKey = apiKeyCacheMissKey(hashHex);
      const serializedMiss = await this.client.get(missKey);
      if (serializedMiss === null) return undefined;
      const missVerification = verifyIdentityCacheEntry({
        key: this.hmacKey as Buffer,
        kind: 'api_key',
        redisKey: missKey,
        serialized: serializedMiss,
      });
      if (!missVerification.authenticated) {
        recordIdentityCacheIntegrityRejection('api_key');
        await this.client.del(missKey);
        return undefined;
      }
      const missData = parseApiKeyCacheData(missVerification.data);
      if (missData === undefined) {
        await this.client.del(missKey);
        return undefined;
      }
      if (missData.type !== 'miss' || missData.freshUntil <= Date.now()) {
        await this.client.del(missKey);
        return undefined;
      }
      const lookupStartedAt = performance.now();
      const remainingMs = Math.min(
        await this.client.pttl(missKey),
        missData.freshUntil - Date.now(),
      );
      if (remainingMs <= 0) {
        await this.client.del(missKey);
        return undefined;
      }
      this.rememberApiKey(hashHex, null, lookupStartedAt + remainingMs);
      return null;
    } catch {
      recordRedisUnavailable('api_key_cache');
      return undefined;
    }
  }

  async set(hashHex: string, record: ApiKeyRecord): Promise<void> {
    const ttlSeconds = shortenedTtl(API_KEY_CACHE_POSITIVE_TTL_SECONDS);
    const freshUntil = Date.now() + ttlSeconds * 1_000;
    this.rememberApiKey(
      hashHex,
      record,
      performance.now() + ttlSeconds * 1_000,
    );
    if (this.client === undefined || this.hmacKey === undefined) return;

    const cacheKey = apiKeyCacheKey(hashHex);
    const data = {
      type: 'record',
      freshUntil,
      record: {
        ...record,
        expiresAt: record.expiresAt?.toISOString() ?? null,
      },
    };
    await this.client
      .set(
        cacheKey,
        signIdentityCacheEntry(
          this.hmacKey as Buffer,
          'api_key',
          cacheKey,
          data,
        ),
        'EX',
        ttlSeconds,
      )
      .catch(() => {
        recordRedisUnavailable('api_key_cache');
      });
  }

  async setMiss(hashHex: string): Promise<void> {
    const ttlSeconds = shortenedTtl(API_KEY_CACHE_NEGATIVE_TTL_SECONDS);
    const freshUntil = Date.now() + ttlSeconds * 1_000;
    this.rememberApiKey(hashHex, null, performance.now() + ttlSeconds * 1_000);
    if (this.client === undefined || this.hmacKey === undefined) return;

    const cacheKey = apiKeyCacheMissKey(hashHex);
    await this.client
      .set(
        cacheKey,
        signIdentityCacheEntry(this.hmacKey as Buffer, 'api_key', cacheKey, {
          type: 'miss',
          freshUntil,
        }),
        'EX',
        ttlSeconds,
      )
      .catch(() => {
        recordRedisUnavailable('api_key_cache');
      });
  }

  async delete(
    hashHex: string,
    invalidationSeam?: ApiKeyCacheInvalidationSeam,
  ): Promise<void> {
    this.localApiKeys.delete(hashHex);
    if (this.client === undefined) return;

    await this.client
      .del(apiKeyCacheKey(hashHex), apiKeyCacheMissKey(hashHex))
      .catch(() => {
        recordRedisUnavailable(invalidationSeam ?? 'api_key_cache');
        return 0;
      });
  }

  async getJwks(
    organizationId: string,
    configVersion: string,
  ): Promise<JwksCacheSnapshot> {
    if (this.client === undefined) {
      return (
        this.readLocalJwks(organizationId, configVersion) ?? {
          generation: '0',
        }
      );
    }

    try {
      const currentGeneration = await this.client.get(
        jwksGenerationKey(organizationId),
      );
      const generation = currentGeneration ?? '0';
      if (this.hmacKey === undefined) {
        // Generation is invalidation metadata, not an unsigned cached entry.
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }

      const cacheKey = jwksKey(organizationId, configVersion, generation);
      const serialized = await this.client.get(cacheKey);
      if (serialized === null) {
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }

      const verification = verifyIdentityCacheEntry({
        key: this.hmacKey as Buffer,
        kind: 'jwks',
        redisKey: cacheKey,
        serialized,
      });
      if (!verification.authenticated) {
        recordIdentityCacheIntegrityRejection('jwks');
        await this.client.del(cacheKey);
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }
      const entry = parseJwksCacheEntry(verification.data);
      if (entry === undefined) {
        await this.client.del(cacheKey);
      }
      if (entry === undefined) {
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }
      const lookupStartedAt = performance.now();
      const remainingMs = Math.min(
        await this.client.pttl(cacheKey),
        entry.staleUntil - Date.now(),
      );
      if (remainingMs <= 0) {
        await this.client.del(cacheKey);
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }
      this.rememberJwks(
        organizationId,
        configVersion,
        generation,
        entry,
        lookupStartedAt + remainingMs,
      );
      return { generation, entry };
    } catch {
      recordRedisUnavailable('jwks_cache');
      return (
        this.readLocalJwks(organizationId, configVersion) ?? {
          generation: '0',
        }
      );
    }
  }

  async setJwks(
    organizationId: string,
    configVersion: string,
    generation: string,
    entry: JwksCacheEntry,
  ): Promise<void> {
    this.rememberJwks(organizationId, configVersion, generation, entry);
    if (
      this.client === undefined ||
      this.hmacKey === undefined ||
      entry.staleUntil <= Date.now()
    ) {
      return;
    }

    const ttlSeconds = Math.max(
      1,
      Math.ceil((entry.staleUntil - Date.now()) / 1_000),
    );
    const cacheKey = jwksKey(organizationId, configVersion, generation);
    await this.client
      .set(
        cacheKey,
        signIdentityCacheEntry(this.hmacKey as Buffer, 'jwks', cacheKey, entry),
        'EX',
        ttlSeconds,
      )
      .catch(() => undefined);
  }

  async deleteJwks(
    organizationId: string,
    configVersion: string,
  ): Promise<void> {
    this.localJwks.delete(localJwksKey(organizationId, configVersion));
    if (this.client === undefined) {
      return;
    }

    const generationKey = jwksGenerationKey(organizationId);
    const generation = (await this.client.get(generationKey)) ?? '0';
    await this.client.incr(generationKey);
    await this.client.del(jwksKey(organizationId, configVersion, generation));
  }

  async tryAcquireRefresh(organizationId: string): Promise<JwksRefreshLock> {
    if (this.client === undefined || this.hmacKey === undefined) {
      return { acquired: false, available: false };
    }

    try {
      const result = await this.client.set(
        jwksRefreshKey(organizationId),
        '1',
        'EX',
        300,
        'NX',
      );
      return { acquired: result === 'OK', available: true };
    } catch {
      recordRedisUnavailable('jwks_cache');
      return { acquired: false, available: false };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private rememberApiKey(
    hashHex: string,
    value: ApiKeyRecord | null,
    expiresAt: number,
  ): void {
    if (expiresAt <= performance.now()) return;
    putBounded(
      this.localApiKeys,
      hashHex,
      { value, expiresAt },
      MAX_LOCAL_API_KEY_ENTRIES,
    );
  }

  private rememberJwks(
    organizationId: string,
    configVersion: string,
    generation: string,
    entry: JwksCacheEntry,
    expiresAt = performance.now() + Math.max(0, entry.staleUntil - Date.now()),
  ): void {
    if (entry.staleUntil <= Date.now() || expiresAt <= performance.now())
      return;
    putBounded(
      this.localJwks,
      localJwksKey(organizationId, configVersion),
      { generation, entry, expiresAt },
      MAX_LOCAL_JWKS_ENTRIES,
    );
  }

  private readLocalJwks(
    organizationId: string,
    configVersion: string,
    generation?: string,
  ): JwksCacheSnapshot | undefined {
    const key = localJwksKey(organizationId, configVersion);
    const cached = this.localJwks.get(key);
    if (cached === undefined) return undefined;
    if (
      cached.expiresAt <= performance.now() ||
      cached.entry.staleUntil <= Date.now()
    ) {
      this.localJwks.delete(key);
      return undefined;
    }
    if (generation !== undefined && cached.generation !== generation) {
      this.localJwks.delete(key);
      return undefined;
    }
    return { generation: cached.generation, entry: cached.entry };
  }
}
