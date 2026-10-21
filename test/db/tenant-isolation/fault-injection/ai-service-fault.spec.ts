import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type Redis from 'ioredis';
import { from, lastValueFrom } from 'rxjs';

import { getMetrics } from '@/common/observability/metrics';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { OperationDispatcherPort } from '@/modules/gateway/application/operation-dispatcher.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { createHttpOperationDispatcher } from '@/modules/gateway/infrastructure/http-operation-dispatcher.testing';
import { RedisConcurrencyLimiter } from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { ConcurrencyPermitInterceptor } from '@/modules/gateway/presentation/concurrency-permit.interceptor';

import { createTenantIsolationRedis } from '../fixtures';

import { eventually, redisTarget, rejection, timed } from './fault-targets';
import { TcpFaultProxy } from './tcp-fault-proxy';

const OPERATION = 'writing.task2.grade' as const;
const DEADLINE_MS = 600;
// The caller must hear back within its deadline plus the time to unwind.
const DEADLINE_SLACK_MS = 400;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

let stub: Server;
let stubRequests = 0;
let stubDelayMs = 0;
let stubInFlight = 0;
let stubPeakInFlight = 0;
let proxy: TcpFaultProxy;
let httpClient: DownstreamHttpClient;
let dispatcher: OperationDispatcherPort;
let gatewayRedis: RedisGatewayClient;
let raw: Redis;
let interceptor: ConcurrencyPermitInterceptor;

const adapter: DownstreamAdapter<unknown, unknown> = {
  operation: OPERATION,
  downstream: 'ai-writing',
  buildRequest: () => ({
    method: 'POST',
    path: '/grading-feedback-task2',
    body: { essay: 'A short essay.' },
  }),
  parseResponse: (response) => response.body,
};

async function cancelledByDeadline(): Promise<number> {
  const match = new RegExp(
    `^aihub_dispatch_cancelled_by_deadline_total\\{operation="${OPERATION}"\\} ([0-9.e+]+)$`,
    'm',
  ).exec(await getMetrics());
  return match === null ? 0 : Number(match[1]);
}

/** One graded request: permit, dispatch, and release, as the route runs it. */
function gradedCall(
  organizationId: string,
  maxConcurrent = 2,
  deadlineMs = DEADLINE_MS,
): Promise<unknown> {
  const requestId = `req_${randomUUID()}`;
  const request = {
    id: requestId,
    aihubAuth: {
      organizationId,
      apiKeyId: 'ak_ai_service_fault',
      environment: 'production',
      maxConcurrent,
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const next: CallHandler = {
    handle: () =>
      from(
        dispatcher.dispatch(OPERATION, {} as never, {
          requestId,
          receivedAt: new Date(),
          deadlineAt: new Date(Date.now() + deadlineMs),
          operationTimeoutMs: deadlineMs,
          organizationId,
          scopes: [],
          signal: new AbortController().signal,
        }),
      ),
  };
  return interceptor
    .intercept(context, next)
    .then((observable) => lastValueFrom(observable));
}

async function inflight(organizationId: string): Promise<number> {
  return raw.zcard(`aihub:v1:inflight:${organizationId}`);
}

beforeAll(async () => {
  stub = createServer((request, response) => {
    stubRequests += 1;
    stubInFlight += 1;
    stubPeakInFlight = Math.max(stubPeakInFlight, stubInFlight);
    response.on('close', () => {
      stubInFlight -= 1;
    });
    request.resume();
    request.on('end', () => {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'success', data: {} }));
      }, stubDelayMs);
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const address = stub.address();
  if (address === null || typeof address === 'string') {
    throw new Error('AI Service stub did not bind');
  }
  proxy = new TcpFaultProxy({ host: '127.0.0.1', port: address.port });
  const proxyPort = await proxy.listen();
  httpClient = new DownstreamHttpClient(`http://127.0.0.1:${proxyPort}`);

  const target = redisTarget();
  const client = createRedisGatewayClient(
    `redis://${target.host}:${target.port}${target.database}`,
  );
  if (client === undefined) throw new Error('Gateway Redis client missing');
  gatewayRedis = client;
  // The gateway client never queues commands, so wait until it is connected.
  await eventually(async () => (await client.ping()) === 'PONG');
  raw = createTenantIsolationRedis();
  interceptor = new ConcurrencyPermitInterceptor(
    new RedisConcurrencyLimiter(gatewayRedis, NOOP_LOGGER),
  );
});

beforeEach(() => {
  // A fresh dispatcher per test, so one test's failures never open the
  // circuit breaker another test reads.
  dispatcher = createHttpOperationDispatcher(
    httpClient,
    { mint: async () => 'internal-token' },
    [adapter],
    {
      beginAttempt: async () => `attempt_${randomUUID()}`,
      recordOutcome: async () => undefined,
    },
  );
});

afterEach(async () => {
  stubDelayMs = 0;
  await proxy.setMode('normal');
});

afterAll(async () => {
  await httpClient.close();
  await proxy.close();
  stub.close();
  await gatewayRedis.quit();
  await raw.quit();
});

describe('AI Service faults on a graded request', () => {
  it('answers 504 AI_SERVICE_TIMEOUT inside the deadline when the service hangs, cancels the call, and releases the permit', async () => {
    const organizationId = `org_ai_hang_${randomUUID().replaceAll('-', '')}`;
    const cancelledBefore = await cancelledByDeadline();
    const closedBefore = proxy.closedClientCount();

    await proxy.setMode('hang');
    const call = await timed(() => gradedCall(organizationId));

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
      httpStatus: 504,
      retryable: true,
    });
    expect(call.ms).toBeLessThan(DEADLINE_MS + DEADLINE_SLACK_MS);
    expect(await inflight(organizationId)).toBe(0);
    expect(await cancelledByDeadline()).toBeGreaterThan(cancelledBefore);
    // The aborted request closes its socket instead of waiting on the service.
    await eventually(async () => proxy.closedClientCount() > closedBefore);
  });

  it('answers 503 AI_SERVICE_UNAVAILABLE at once when the service refuses connections, and releases the permit', async () => {
    const organizationId = `org_ai_refuse_${randomUUID().replaceAll('-', '')}`;
    const requestsBefore = stubRequests;

    await proxy.setMode('refuse');
    const call = await timed(() => gradedCall(organizationId));

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(call.ms).toBeLessThan(DEADLINE_MS);
    expect(stubRequests).toBe(requestsBefore);
    expect(await inflight(organizationId)).toBe(0);
  });

  it('grades again once the service returns', async () => {
    const organizationId = `org_ai_recover_${randomUUID().replaceAll('-', '')}`;
    await proxy.setMode('refuse');
    await expect(gradedCall(organizationId)).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
    });

    await proxy.setMode('normal');
    await eventually(async () => {
      await gradedCall(organizationId);
      return true;
    });
    expect(await inflight(organizationId)).toBe(0);
  });
});

describe('a slow AI Service under grading load and client retries', () => {
  // The #327 baseline sustains 8 RPS of mixed grading with a 2 s AI Service.
  // This holds that rate while the service slows to twice its baseline
  // latency, past the request deadline, and every refused client retries.
  const OFFERED_RPS = 8;
  const LOAD_SECONDS = 4;
  const ORGANIZATION_PERMITS = 20;
  const LOAD_DEADLINE_MS = 3_000;
  const POOL_CONNECTIONS = 10;
  const CIRCUIT_RESET_MS = 30_000;

  it('refuses and times out within bounds, keeps queues and memory bounded, leaks no permit, and recovers', async () => {
    const organizations = [1, 2].map(
      (index) => `org_overload_${index}_${randomUUID().replaceAll('-', '')}`,
    );
    const rssBefore = process.memoryUsage().rss;
    stubDelayMs = 4_000;
    stubPeakInFlight = 0;
    let peakPermits = 0;
    const sampler = setInterval(() => {
      void Promise.all(organizations.map(inflight)).then((counts) => {
        peakPermits = Math.max(peakPermits, ...counts);
        return undefined;
      });
    }, 100);

    const outcomes: { readonly code: string; readonly ms: number }[] = [];
    const attempt = async (organizationId: string): Promise<void> => {
      for (let tries = 0; tries < 2; tries += 1) {
        const call = await timed(() =>
          gradedCall(organizationId, ORGANIZATION_PERMITS, LOAD_DEADLINE_MS),
        );
        const error =
          call.result.status === 'rejected'
            ? (call.result.reason as {
                readonly code?: string;
                readonly retryable?: boolean;
                readonly retryAfterMs?: number;
              })
            : undefined;
        outcomes.push({ code: error?.code ?? 'OK', ms: call.ms });
        if (error?.retryable !== true) return;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(error.retryAfterMs ?? 200, 500)),
        );
      }
    };

    const clients: Promise<void>[] = [];
    try {
      for (let index = 0; index < OFFERED_RPS * LOAD_SECONDS; index += 1) {
        clients.push(attempt(organizations[index % 2] ?? ''));
        await new Promise((resolve) =>
          setTimeout(resolve, 1_000 / OFFERED_RPS),
        );
      }
      await Promise.all(clients);
    } finally {
      clearInterval(sampler);
    }

    // Every caller hears back by its deadline, with a retryable answer:
    // admitted calls time out, excess calls are refused, and once enough
    // calls time out the circuit breaker answers AI_SERVICE_UNAVAILABLE.
    for (const outcome of outcomes) {
      expect([
        'OK',
        'AI_SERVICE_TIMEOUT',
        'AI_SERVICE_UNAVAILABLE',
        'CONCURRENCY_LIMIT',
      ]).toContain(outcome.code);
      expect(outcome.ms).toBeLessThan(LOAD_DEADLINE_MS + DEADLINE_SLACK_MS);
    }
    expect(
      outcomes.some((outcome) => outcome.code === 'AI_SERVICE_TIMEOUT'),
    ).toBe(true);
    // Queues stay inside the admitted permits and the connection pool.
    expect(peakPermits).toBeLessThanOrEqual(ORGANIZATION_PERMITS);
    expect(stubPeakInFlight).toBeLessThanOrEqual(POOL_CONNECTIONS);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(150 * 1024 ** 2);

    // Nothing is left holding a permit, and the service is usable again.
    for (const organizationId of organizations) {
      expect(await inflight(organizationId)).toBe(0);
    }
    // An open circuit breaker probes again after its 30 s reset timeout.
    stubDelayMs = 0;
    await eventually(async () => {
      const recovered = await timed(() => gradedCall(organizations[0] ?? ''));
      return recovered.result.status === 'fulfilled' && recovered.ms < 1_000;
    }, CIRCUIT_RESET_MS + 5_000);
  }, 90_000);
});
