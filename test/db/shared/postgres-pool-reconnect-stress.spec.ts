import { Client, type Pool } from 'pg';

import { getMetrics } from '@/common/observability/metrics';
import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { TcpFaultProxy } from '../tenant-isolation/fault-injection/tcp-fault-proxy';
import { testDatabaseUrl } from './database';

/**
 * #1608 stress: a PostgreSQL restart under 100 concurrent incoming queries.
 *
 * A local TCP proxy fronts the lane database, so the spec can take it away
 * (the refused phase of a restart) and bring it back (recovery) without
 * controlling the container. Every result is collected, so nothing can become
 * an unhandled rejection; the spec fails if one fires anyway.
 */

const POOL_NAME = 'integration-test';
const CONCURRENCY = 100;
const RESTART_DOWN_MS = 2_000;

let upstream: URL;
let proxy: TcpFaultProxy;
let proxyPort = 0;
let proxyUp = false;

function poolUrl(): string {
  const target = new URL(upstream.href);
  target.hostname = '127.0.0.1';
  target.port = String(proxyPort);
  target.username = decodeURIComponent(upstream.username);
  if (upstream.password.length > 0) {
    target.password = decodeURIComponent(upstream.password);
  }
  return target.href;
}

async function startProxy(): Promise<void> {
  proxy = new TcpFaultProxy({
    host: upstream.hostname,
    port: Number(upstream.port),
  });
  proxyPort = await proxy.listen();
  proxyUp = true;
}

async function proxyReady(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (proxyUp && (await probeSucceeds())) return;
    if (Date.now() > deadline) throw new Error('proxy did not come back');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function probeSucceeds(): Promise<boolean> {
  const probe = new Client({
    connectionString: poolUrl(),
    connectionTimeoutMillis: 500,
  });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

function metricLine(payload: string, metric: string): number {
  const line = payload
    .split('\n')
    .find((candidate) => candidate.startsWith(metric));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

describe('PostgreSQL restart under 100 concurrent queries (#1608)', () => {
  let pool: Pool;
  const unhandled: Array<{ reason: unknown; promise: Promise<unknown> }> = [];
  const onUnhandled = (reason: unknown, promise: Promise<unknown>): void => {
    unhandled.push({ reason, promise });
  };
  let exitCode: unknown;

  beforeAll(async () => {
    upstream = new URL(testDatabaseUrl());
    await startProxy();
    pool = createPostgresPool(POOL_NAME, {
      connectionString: poolUrl(),
      max: 10,
      connectionTimeoutMillis: 250,
      idleTimeoutMillis: 30_000,
    });
    process.on('unhandledRejection', onUnhandled);
    exitCode = process.exitCode;
  });

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await pool.end().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  });

  it('loses and recovers every connection without an unhandled rejection', async () => {
    await expect(pool.query('SELECT 1')).resolves.toBeDefined();

    // Restart: proxy refuses new connections and drops open ones.
    await proxy.setMode('refuse');

    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => pool.query('SELECT 1')),
    );
    expect(settled).toHaveLength(CONCURRENCY);
    for (const outcome of settled) {
      // Every request holds its answer: a rejection, never a hang or a crash.
      expect(['fulfilled', 'rejected']).toContain(outcome.status);
    }
    expect(unhandled).toEqual([]);
    expect(process.exitCode).toBe(exitCode);

    // The breaker tripped and the refusals were counted.
    const downMetrics = await getMetrics();
    expect(
      metricLine(
        downMetrics,
        `aihub_postgres_pool_breaker_transitions_total{pool="${POOL_NAME}",state="open"} `,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      metricLine(
        downMetrics,
        `aihub_postgres_pool_shed_total{pool="${POOL_NAME}"} `,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      metricLine(
        downMetrics,
        `aihub_postgres_pool_connect_retry_latency_seconds_count{pool="${POOL_NAME}",outcome="failure"} `,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      metricLine(
        downMetrics,
        `aihub_postgres_pool_backoff_delay_seconds_count{pool="${POOL_NAME}"} `,
      ),
    ).toBeGreaterThanOrEqual(1);

    // Recovery: after the breaker's cooldown a probe closes it again.
    await proxy.setMode('normal');
    await proxyReady();
    await new Promise((resolve) => setTimeout(resolve, RESTART_DOWN_MS));
    await expect(pool.query('SELECT 1')).resolves.toBeDefined();

    const upMetrics = await getMetrics();
    expect(
      metricLine(
        upMetrics,
        `aihub_postgres_pool_breaker_transitions_total{pool="${POOL_NAME}",state="closed"} `,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(unhandled).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });
});
