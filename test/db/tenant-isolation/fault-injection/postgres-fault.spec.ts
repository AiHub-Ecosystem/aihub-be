import { randomUUID } from 'node:crypto';

import {
  QUERY_TIMEOUT_MARGIN_MS,
  REQUEST_POSTGRES_TIMEOUTS,
} from '@/common/postgres/postgres-pool';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { ApiKeyAuthenticator } from '@/modules/identity/api-keys/application/api-key-authenticator';
import type {
  ApiKeyCachePort,
  AuthFailureCounterPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { PostgresApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/postgres-usage.repository';
import { HttpExceptionFilter } from '@/modules/metering/presentation/http-exception.filter';
import { createPrismaClient } from '@/modules/persistence/persistence.module';

import { createTestPool } from '../../shared/database';
import {
  ORGANIZATION_A,
  TEST_NOW,
  type TenantIsolationFixture,
  createTenantIsolationRedis,
} from '../fixtures';

import {
  eventually,
  postgresThroughProxy,
  rejection,
  resetAndSeedTenants,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// A refused or unreachable server fails at connectionTimeoutMillis (1 s); a
// server that stops answering an open connection fails at query_timeout.
const REFUSED_BOUND_MS = 2_000;
const STALLED_BOUND_MS =
  REQUEST_POSTGRES_TIMEOUTS.statement_timeout + QUERY_TIMEOUT_MARGIN_MS + 1_500;

const noCache: ApiKeyCachePort = {
  get: async () => undefined,
  set: async () => undefined,
  setMiss: async () => undefined,
  delete: async () => undefined,
};

const noFailures: AuthFailureCounterPort = {
  get: async () => 0,
  recordFailure: async () => 0,
};

const DATABASE_UNAVAILABLE_ANSWER = {
  status: 503,
  // The hint is spread over [1 s, 2 s) (#1352), so the header rounds up to 1 or 2.
  retryAfter: expect.stringMatching(/^[12]$/) as unknown,
  error: {
    code: 'DATABASE_UNAVAILABLE',
    retryable: true,
    retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
  },
};

/** What a client receives for an error: the real exception filter's answer. */
async function answerFor(error: unknown) {
  let status = 0;
  let retryAfter: string | undefined;
  let body: { readonly error?: Record<string, unknown> } = {};
  const response = {
    header: (name: string, value: string) => {
      if (name === 'Retry-After') retryAfter = value;
    },
    status: (code: number) => {
      status = code;
      return {
        send: (sent: typeof body) => {
          body = sent;
        },
      };
    },
  };
  await new HttpExceptionFilter({ finalize: async () => undefined }).catch(
    error,
    new ExecutionContextHost([{ id: 'req_fault', headers: {} }, response]),
  );
  return {
    status,
    retryAfter,
    error: {
      code: body.error?.code,
      retryable: body.error?.retryable,
      retryAfterMs: body.error?.retry_after_ms,
    },
  };
}

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let proxy: TcpFaultProxy;
let proxiedUrl: string;
let fixture: TenantIsolationFixture;

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  const target = await postgresThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
});

beforeEach(async () => {
  await proxy.setMode('normal');
  fixture = await resetAndSeedTenants(pool, raw);
});

afterAll(async () => {
  await proxy.close();
  await pool.end();
  await raw.quit();
});

function usageRecord() {
  return {
    requestId: `req_${randomUUID()}`,
    organizationId: ORGANIZATION_A,
    apiKeyId: fixture.organizationA.apiKey.id,
    service: 'writing',
    operation: 'writing.task2.grade',
    environment: 'production',
    outcome: 'success' as const,
    httpStatus: 200,
    billableRequests: 1,
    meteringStatus: 'not_applicable' as const,
    totalMs: 1,
    billingBasis: 'response' as const,
  };
}

describe.each<[FaultMode, number]>([
  ['refuse', REFUSED_BOUND_MS],
  ['hang', STALLED_BOUND_MS],
])('Postgres while it is %s', (mode, boundMs) => {
  it('fails API-key lookup and usage writes as a retryable outage inside the bound, then recovers without leaking connections', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    const authenticator = new ApiKeyAuthenticator(
      new PostgresApiKeyRepository(holder.prisma),
      noCache,
      noFailures,
      () => TEST_NOW,
    );
    const usage = new PostgresUsageRepository(holder.prisma);
    const credential = {
      value: fixture.organizationA.apiKey.raw,
      environment: 'production',
      clientIp: '198.51.100.8',
    };

    try {
      // Open pooled connections first, so the stall hits a live connection.
      await expect(
        authenticator.authenticate(credential),
      ).resolves.toMatchObject({ organizationId: ORGANIZATION_A });

      await proxy.setMode(mode);
      const lookup = await timed(() => authenticator.authenticate(credential));
      const write = await timed(() => usage.insert(usageRecord()));

      // The identity store answers the outage itself; the usage write's
      // driver error is mapped by the exception filter. Both reach the
      // client as the same retryable answer.
      expect(await answerFor(rejection(lookup.result))).toEqual(
        DATABASE_UNAVAILABLE_ANSWER,
      );
      expect(await answerFor(rejection(write.result))).toEqual(
        DATABASE_UNAVAILABLE_ANSWER,
      );
      expect(Math.max(lookup.ms, write.ms)).toBeLessThan(boundMs);

      await proxy.setMode('normal');
      await eventually(async () => {
        await authenticator.authenticate(credential);
        return true;
      }, 5_000);
      await usage.insert(usageRecord());
      await eventually(
        // Every pooled connection is idle again: none is held checked out.
        async () => holder.pool.idleCount === holder.pool.totalCount,
        5_000,
      );
      expect(holder.pool.totalCount).toBeLessThanOrEqual(10);
    } finally {
      await proxy.setMode('normal');
      await holder.close();
    }
  }, 30_000);
});

/** An API-key lookup and a usage write over a link that delays each chunk. */
async function callsOverSlowLink(slowMs: number) {
  const slow = await postgresThroughProxy(slowMs);
  await slow.proxy.setMode('slow');
  const holder = createPrismaClient('integration-test', slow.url);
  const authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(holder.prisma),
    noCache,
    noFailures,
    () => TEST_NOW,
  );
  const usage = new PostgresUsageRepository(holder.prisma);
  try {
    const lookup = await timed(() =>
      authenticator.authenticate({
        value: fixture.organizationA.apiKey.raw,
        environment: 'production',
        clientIp: '198.51.100.9',
      }),
    );
    const write = await timed(() => usage.insert(usageRecord()));
    return { lookup, write };
  } finally {
    await holder.close();
    await slow.proxy.close();
  }
}

it('keeps serving through a slightly slow Postgres', async () => {
  // Tens of milliseconds per chunk still connects and answers.
  const { lookup, write } = await callsOverSlowLink(25);

  expect(lookup.result).toMatchObject({
    status: 'fulfilled',
    value: { organizationId: ORGANIZATION_A },
  });
  expect(write.result.status).toBe('fulfilled');
  expect(Math.max(lookup.ms, write.ms)).toBeLessThan(STALLED_BOUND_MS);
}, 30_000);

it('refuses as a retryable outage inside the bound when Postgres is slower than the connect timeout', async () => {
  // A round trip longer than the 1 s connect timeout never gets a connection.
  const { lookup, write } = await callsOverSlowLink(1_500);

  expect(await answerFor(rejection(lookup.result))).toEqual(
    DATABASE_UNAVAILABLE_ANSWER,
  );
  expect(await answerFor(rejection(write.result))).toEqual(
    DATABASE_UNAVAILABLE_ANSWER,
  );
  expect(Math.max(lookup.ms, write.ms)).toBeLessThan(REFUSED_BOUND_MS + 1_000);
}, 30_000);
