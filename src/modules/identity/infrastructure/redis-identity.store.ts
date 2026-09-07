import Redis from 'ioredis';

import type {
  ApiKeyCachePort,
  ApiKeyRecord,
  AuthFailureCounterPort,
} from '../application/api-key-authenticator.port';
import type {
  JwksCacheEntry,
  JwksCachePort,
  JwksRefreshLock,
} from '../application/jwks-cache.port';
import { parsePublicJsonWebKeySet } from '../domain/organization-identity-config';

export interface RedisIdentityClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    condition?: 'NX',
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<unknown>;
}

class IoredisIdentityClient implements RedisIdentityClient {
  constructor(private readonly client: Redis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayValue(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function dateValue(
  record: Record<string, unknown>,
  key: string,
): Date | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function positiveIntegerValue(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function quotaValue(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function statusValue(
  record: Record<string, unknown>,
  key: string,
): 'active' | 'revoked' | 'suspended' | undefined {
  const value = record[key];
  return value === 'active' || value === 'revoked' || value === 'suspended'
    ? value
    : undefined;
}

function booleanValue(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseCachedRecord(serialized: string): ApiKeyRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const organizationId = stringValue(value, 'organizationId');
  const apiKeyId = stringValue(value, 'apiKeyId');
  const organizationStatus = statusValue(value, 'organizationStatus');
  const status = statusValue(value, 'status');
  const scopes = stringArrayValue(value, 'scopes');
  const entitlements = stringArrayValue(value, 'entitlements');
  const allowedEnvironments = stringArrayValue(value, 'allowedEnvironments');
  const expiresAt = dateValue(value, 'expiresAt');
  const rateLimitRpm = positiveIntegerValue(value, 'rateLimitRpm');
  const maxConcurrent = positiveIntegerValue(value, 'maxConcurrent');
  const monthlyRequestQuota = quotaValue(value, 'monthlyRequestQuota');
  const hardStopOnQuota = booleanValue(value, 'hardStopOnQuota');

  if (
    organizationId === undefined ||
    apiKeyId === undefined ||
    (organizationStatus !== 'active' && organizationStatus !== 'suspended') ||
    (status !== 'active' && status !== 'revoked') ||
    scopes === undefined ||
    entitlements === undefined ||
    allowedEnvironments === undefined ||
    expiresAt === undefined ||
    rateLimitRpm === undefined ||
    maxConcurrent === undefined ||
    monthlyRequestQuota === undefined ||
    hardStopOnQuota === undefined
  ) {
    return undefined;
  }

  return {
    organizationId,
    apiKeyId,
    organizationStatus,
    status,
    scopes,
    entitlements,
    allowedEnvironments,
    expiresAt,
    rateLimitRpm,
    maxConcurrent,
    monthlyRequestQuota,
    hardStopOnQuota,
  };
}

function cacheKey(hashHex: string): string {
  return `aihub:v1:key:${hashHex}`;
}

function missKey(hashHex: string): string {
  return `aihub:v1:key:miss:${hashHex}`;
}

function jwksKey(organizationId: string): string {
  return `aihub:v1:jwks:${organizationId}`;
}

function jwksRefreshKey(organizationId: string): string {
  return `aihub:v1:jwks-refresh:${organizationId}`;
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

  constructor(url: string, client?: RedisIdentityClient) {
    this.client = client ?? connect(url);
  }

  async get(hashHex: string): Promise<ApiKeyRecord | null | undefined> {
    if (this.client === undefined) {
      return undefined;
    }

    try {
      const serialized = await this.client.get(cacheKey(hashHex));
      if (serialized !== null) {
        const record = parseCachedRecord(serialized);
        if (record !== undefined) {
          return record;
        }
        await this.client.del(cacheKey(hashHex));
        return undefined;
      }

      const miss = await this.client.get(missKey(hashHex));
      return miss === '1' ? null : undefined;
    } catch {
      return undefined;
    }
  }

  async set(hashHex: string, record: ApiKeyRecord): Promise<void> {
    if (this.client === undefined) {
      return;
    }

    const serialized = JSON.stringify({
      ...record,
      expiresAt: record.expiresAt?.toISOString() ?? null,
    });
    await this.client
      .set(cacheKey(hashHex), serialized, 'EX', 60)
      .catch(() => undefined);
  }

  async setMiss(hashHex: string): Promise<void> {
    if (this.client === undefined) {
      return;
    }

    await this.client
      .set(missKey(hashHex), '1', 'EX', 30)
      .catch(() => undefined);
  }

  async delete(hashHex: string): Promise<void> {
    if (this.client === undefined) {
      return;
    }

    await this.client.del(cacheKey(hashHex), missKey(hashHex)).catch(() => 0);
  }

  async getJwks(organizationId: string): Promise<JwksCacheEntry | undefined> {
    if (this.client === undefined) {
      return undefined;
    }

    try {
      const serialized = await this.client.get(jwksKey(organizationId));
      if (serialized === null) {
        return undefined;
      }

      const entry = parseJwksCacheEntry(serialized);
      if (entry === undefined) {
        await this.client.del(jwksKey(organizationId));
      }
      return entry;
    } catch {
      return undefined;
    }
  }

  async setJwks(organizationId: string, entry: JwksCacheEntry): Promise<void> {
    if (this.client === undefined) {
      return;
    }

    const ttlSeconds = Math.max(
      1,
      Math.ceil((entry.staleUntil - Date.now()) / 1_000),
    );
    await this.client
      .set(jwksKey(organizationId), JSON.stringify(entry), 'EX', ttlSeconds)
      .catch(() => undefined);
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
}

export class RedisAuthFailureCounter implements AuthFailureCounterPort {
  private readonly client: RedisIdentityClient | undefined;

  constructor(url: string, client?: RedisIdentityClient) {
    this.client = client ?? connect(url);
  }

  async get(ip: string): Promise<number> {
    if (this.client === undefined) {
      return 0;
    }

    try {
      const value = await this.client.get(`aihub:v1:authfail:${ip}`);
      const count = Number(value ?? '0');
      return Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      return 0;
    }
  }

  async recordFailure(ip: string): Promise<number> {
    if (this.client === undefined) {
      return 0;
    }

    try {
      const key = `aihub:v1:authfail:${ip}`;
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, 300);
      }
      return count;
    } catch {
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
