import type Redis from 'ioredis';
import type { Pool } from 'pg';

import { getMetrics } from '@/common/observability/metrics';
import type { RedisProtectionSeam } from '@/common/observability/redis-unavailable-metric';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';

import { testDatabaseUrl } from '../../shared/database';
import {
  TEST_NOW,
  type TenantIsolationFixture,
  createTenantIdentity,
  resetTenantIsolation,
  seedTenantIsolation,
} from '../fixtures';

import { TcpFaultProxy } from './tcp-fault-proxy';

/** A metric's current value from the exposition, or 0 before it is set. */
export async function metricValue(
  name: string,
  labels: Readonly<Record<string, string>>,
): Promise<number> {
  const labelText = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}{${labelText}} `));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
}

export function redisUnavailableCount(
  seam: RedisProtectionSeam,
): Promise<number> {
  return metricValue('aihub_redis_unavailable_total', { seam });
}

/** Concurrency leases Redis holds for an Organization, or for all Sandbox. */
export function inflight(raw: Redis, organizationId: string): Promise<number> {
  return raw.zcard(`aihub:v1:inflight:${organizationId}`);
}

export function sandboxInflight(raw: Redis): Promise<number> {
  return raw.zcard('aihub:v1:inflight:sandbox');
}

/** Clears the lane and seeds tenants A and B with fresh keys and identities. */
export async function resetAndSeedTenants(
  pool: Pool,
  raw: Redis,
): Promise<TenantIsolationFixture> {
  await resetTenantIsolation(pool, raw);
  return seedTenantIsolation(
    pool,
    await createTenantIdentity('https://tenant-a.example.test', 'tenant-a-key'),
    await createTenantIdentity('https://tenant-b.example.test', 'tenant-b-key'),
    generateOrganizationApiKey(TEST_NOW),
    generateOrganizationApiKey(TEST_NOW),
  );
}

export async function redisAnswers(client: {
  ping(): Promise<string>;
}): Promise<void> {
  await eventually(async () => (await client.ping()) === 'PONG');
}

export interface FaultTarget {
  readonly host: string;
  readonly port: number;
}

function loopbackHost(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' ? '127.0.0.1' : host;
}

/** The lane's Redis database 15, the only Redis these tests may touch. */
export function redisTarget(): FaultTarget & { readonly database: string } {
  const target = new URL(
    process.env.TENANT_ISOLATION_REDIS_URL?.trim() ||
      'redis://127.0.0.1:6379/15',
  );
  const host = loopbackHost(target);
  if (
    target.protocol !== 'redis:' ||
    !['127.0.0.1', '::1'].includes(host) ||
    target.pathname !== '/15' ||
    target.username !== '' ||
    target.password !== ''
  ) {
    throw new Error('Fault tests require loopback Redis database 15');
  }
  return {
    host,
    port: Number(target.port || 6379),
    database: target.pathname,
  };
}

/** A proxy in front of the lane Redis and the Redis URL that goes through it. */
export async function redisThroughProxy(
  slowMs?: number,
): Promise<{ readonly proxy: TcpFaultProxy; readonly url: string }> {
  const target = redisTarget();
  const proxy = new TcpFaultProxy(target, slowMs);
  const port = await proxy.listen();
  return { proxy, url: `redis://127.0.0.1:${port}${target.database}` };
}

/** A proxy in front of the lane database and the URL that goes through it. */
export async function postgresThroughProxy(
  slowMs?: number,
): Promise<{ readonly proxy: TcpFaultProxy; readonly url: string }> {
  const direct = new URL(testDatabaseUrl());
  const proxy = new TcpFaultProxy(
    { host: loopbackHost(direct), port: Number(direct.port || 5432) },
    slowMs,
  );
  const port = await proxy.listen();
  const url = new URL(direct);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return { proxy, url: url.toString() };
}

/** Milliseconds an async call took, with its outcome. */
export async function timed<T>(
  run: () => Promise<T>,
): Promise<{ readonly ms: number; readonly result: PromiseSettledResult<T> }> {
  const startedAt = performance.now();
  const [result] = await Promise.allSettled([run()]);
  return { ms: performance.now() - startedAt, result };
}

export function rejection(result: PromiseSettledResult<unknown>): unknown {
  if (result.status !== 'rejected') {
    throw new Error('Expected the call to fail during the fault');
  }
  return result.reason;
}

export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Condition was not met after the fault cleared');
}
