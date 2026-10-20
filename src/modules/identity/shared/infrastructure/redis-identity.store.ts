import { apiKeyRecordFromRow } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { incrementRedisCounterWithExpiry } from '@/common/redis/increment-with-expiry';
import type {
  ApiKeyCachePort,
  ApiKeyRecord,
  AuthFailureCounterPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
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
import { putBounded, shortenedTtl } from './local-cache-policy';

export interface RedisIdentityClient {
  get(key: string): Promise<string | null>;
  pttl(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<unknown>;
}

class IoredisIdentityClient implements RedisIdentityClient {
  constructor(private readonly client: Redis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }

  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<unknown> {
    return condition === undefined
      ? this.client.set(key, value, mode, seconds)
      : this.client.set(key, value, mode, seconds, condition);
  }

  del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    return this.client.eval(script, numberOfKeys, ...args).then((result) => {
      if (typeof result !== 'number') {
        throw new Error('Redis command result is invalid');
      }
      return result;
    });
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  quit(): Promise<unknown> {
    return this.client.quit();
  }
}

function connect(url: string): RedisIdentityClient | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }

  const client = new Redis(url, {
    commandTimeout: 100,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', () => undefined);
  return new IoredisIdentityClient(client);
}

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
}

function localJwksKey(organizationId: string, configVersion: string): string {
  return JSON.stringify([organizationId, configVersion]);
}

function parseJwksCacheEntry(serialized: string): JwksCacheEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const jwks = parsePublicJsonWebKeySet(record.jwks);
  const freshUntil = record.freshUntil;
  const staleUntil = record.staleUntil;
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
  private readonly localApiKeys = new Map<string, LocalApiKeyEntry>();
  private readonly localJwks = new Map<string, LocalJwksEntry>();

  constructor(url: string, client?: RedisIdentityClient) {
    this.client = client ?? connect(url);
  }

  async get(hashHex: string): Promise<ApiKeyRecord | null | undefined> {
    const local = this.localApiKeys.get(hashHex);
    if (local !== undefined) {
      if (local.expiresAt > performance.now()) return local.value;
      this.localApiKeys.delete(hashHex);
    }

    if (this.client === undefined) {
      return undefined;
    }

    try {
      const serialized = await this.client.get(apiKeyCacheKey(hashHex));
      if (serialized !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(serialized);
        } catch {
          parsed = undefined;
        }
        const record =
          parsed === undefined ? undefined : apiKeyRecordFromRow(parsed);
        if (record !== undefined) {
          const lookupStartedAt = performance.now();
          const remainingMs = await this.client.pttl(apiKeyCacheKey(hashHex));
          if (remainingMs <= 0) {
            await this.client.del(apiKeyCacheKey(hashHex));
            return undefined;
          }
          this.rememberApiKey(hashHex, record, lookupStartedAt + remainingMs);
          return record;
        }
        await this.client.del(apiKeyCacheKey(hashHex));
        return undefined;
      }

      const miss = await this.client.get(apiKeyCacheMissKey(hashHex));
      if (miss !== '1') return undefined;
      const lookupStartedAt = performance.now();
      const remainingMs = await this.client.pttl(apiKeyCacheMissKey(hashHex));
      if (remainingMs <= 0) {
        await this.client.del(apiKeyCacheMissKey(hashHex));
        return undefined;
      }
      this.rememberApiKey(hashHex, null, lookupStartedAt + remainingMs);
      return null;
    } catch {
      return undefined;
    }
  }

  async set(hashHex: string, record: ApiKeyRecord): Promise<void> {
    const ttlSeconds = shortenedTtl(API_KEY_CACHE_POSITIVE_TTL_SECONDS);
    this.rememberApiKey(
      hashHex,
      record,
      performance.now() + ttlSeconds * 1_000,
    );
    if (this.client === undefined) return;

    const serialized = JSON.stringify({
      ...record,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    });
    await this.client
      .set(apiKeyCacheKey(hashHex), serialized, 'EX', ttlSeconds)
      .catch(() => undefined);
  }

  async setMiss(hashHex: string): Promise<void> {
    const ttlSeconds = shortenedTtl(API_KEY_CACHE_NEGATIVE_TTL_SECONDS);
    this.rememberApiKey(hashHex, null, performance.now() + ttlSeconds * 1_000);
    if (this.client === undefined) return;

    await this.client
      .set(apiKeyCacheMissKey(hashHex), '1', 'EX', ttlSeconds)
      .catch(() => undefined);
  }

  async delete(hashHex: string): Promise<void> {
    this.localApiKeys.delete(hashHex);
    if (this.client === undefined) return;

    await this.client
      .del(apiKeyCacheKey(hashHex), apiKeyCacheMissKey(hashHex))
      .catch(() => 0);
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
      const serialized = await this.client.get(
        jwksKey(organizationId, configVersion, generation),
      );
      if (serialized === null) {
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }

      const entry = parseJwksCacheEntry(serialized);
      if (entry === undefined) {
        await this.client.del(
          jwksKey(organizationId, configVersion, generation),
        );
      }
      if (entry === undefined) {
        return (
          this.readLocalJwks(organizationId, configVersion, generation) ?? {
            generation,
          }
        );
      }
      this.rememberJwks(organizationId, configVersion, generation, entry);
      return { generation, entry };
    } catch {
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
    if (this.client === undefined) return;

    const ttlSeconds = Math.max(
      1,
      Math.ceil((entry.staleUntil - Date.now()) / 1_000),
    );
    await this.client
      .set(
        jwksKey(organizationId, configVersion, generation),
        JSON.stringify(entry),
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
      throw new Error('Redis is unavailable');
    }

    const generationKey = jwksGenerationKey(organizationId);
    const generation = (await this.client.get(generationKey)) ?? '0';
    await this.client.incr(generationKey);
    await this.client.del(jwksKey(organizationId, configVersion, generation));
  }

  async tryAcquireRefresh(organizationId: string): Promise<JwksRefreshLock> {
    if (this.client === undefined) {
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
  ): void {
    if (entry.staleUntil <= Date.now()) return;
    putBounded(
      this.localJwks,
      localJwksKey(organizationId, configVersion),
      { generation, entry },
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
    if (cached.entry.staleUntil <= Date.now()) {
      this.localJwks.delete(key);
      return undefined;
    }
    if (generation !== undefined && cached.generation !== generation) {
      return undefined;
    }
    return { generation: cached.generation, entry: cached.entry };
  }
}

export class RedisAuthFailureCounter implements AuthFailureCounterPort {
  private readonly client: RedisIdentityClient | undefined;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;
  private readonly degradedOperations = new Set<'read' | 'write'>();

  constructor(
    url: string,
    client?: RedisIdentityClient,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(
      RedisAuthFailureCounter.name,
    ),
  ) {
    this.client = client ?? connect(url);
    this.logger = logger;
  }

  async get(ip: string): Promise<number> {
    if (this.client === undefined) {
      return 0;
    }

    try {
      const value = await this.client.get(`aihub:v1:authfail:${ip}`);
      const count = Number(value ?? '0');
      this.reportRecovered('read');
      return Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      this.reportDegraded('read');
      return 0;
    }
  }

  async recordFailure(ip: string): Promise<number> {
    const client = this.client;
    if (client === undefined) {
      return 0;
    }

    try {
      const key = `aihub:v1:authfail:${ip}`;
      const count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        key,
        300,
      );
      this.reportRecovered('write');
      return count;
    } catch {
      this.reportDegraded('write');
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private reportDegraded(operation: 'read' | 'write'): void {
    const wasDegraded = this.degradedOperations.size > 0;
    this.degradedOperations.add(operation);
    if (wasDegraded) {
      return;
    }

    this.logger.warn(
      'Redis API-key authentication failure counter unavailable; brute-force protection is failing open until it recovers',
    );
  }

  private reportRecovered(operation: 'read' | 'write'): void {
    if (
      !this.degradedOperations.delete(operation) ||
      this.degradedOperations.size > 0
    ) {
      return;
    }

    this.logger.log('Redis API-key authentication failure counter recovered');
  }
}
