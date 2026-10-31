import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import type { CallHandler } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type Redis from 'ioredis';
import { from, lastValueFrom } from 'rxjs';

import type { GradeTask2Request } from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { OperationDispatcherPort } from '@/modules/gateway/application/operation-dispatcher.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { createHttpOperationDispatcher } from '@/modules/gateway/infrastructure/http-operation-dispatcher.testing';
import {
  CONCURRENCY_RETRY_AFTER_MS,
  RedisConcurrencyLimiter,
} from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { ConcurrencyPermitInterceptor } from '@/modules/gateway/presentation/concurrency-permit.interceptor';

import { createTenantIsolationRedis } from '../fixtures';

import {
  eventually,
  inflight,
  metricValue,
  redisAnswers,
  redisTarget,
  rejection,
  timed,
} from './fault-targets';
import { TcpFaultProxy } from './tcp-fault-proxy';

const OPERATION = 'writing.task2.grade' as const;
const DEADLINE_MS = 600;
// The caller must hear back within its deadline plus the time to unwind.
const DEADLINE_SLACK_MS = 400;
// A refusal is decided before any downstream call, so it is fast.
const REFUSAL_BOUND_MS = 300;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

const GRADING_INPUT: GradeTask2Request = {
  question: 'Some people think schools should teach coding. Discuss.',
  topic: 'education',
  essay: 'A short essay.',
};

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

const adapter: DownstreamAdapter<GradeTask2Request, unknown> = {
  operation: OPERATION,
  downstream: 'ai-writing',
  buildRequest: (input) => ({
    method: 'POST',
    path: '/v1/grading-feedback-task2',
    body: input,
  }),
  parseResponse: (response) => response.body,
};

function cancelledByDeadline(): Promise<number> {
  return metricValue('aihub_dispatch_cancelled_by_deadline_total', {
    operation: OPERATION,
  });
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
  const next: CallHandler = {
    handle: () =>
      from(
        dispatcher.dispatch(OPERATION, GRADING_INPUT, {
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
    .intercept(new ExecutionContextHost([request]), next)
    .then((observable) => lastValueFrom(observable));
}

function organizationId(label: string): string {
  return `org_ai_${label}_${randomUUID().replaceAll('-', '')}`;
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
  await redisAnswers(client);
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
    const organization = organizationId('hang');
    const cancelledBefore = await cancelledByDeadline();
    const closedBefore = proxy.closedClientCount();

    await proxy.setMode('hang');
    const call = await timed(() => gradedCall(organization));

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_TIMEOUT',
      httpStatus: 504,
      retryable: true,
    });
    expect(call.ms).toBeLessThan(DEADLINE_MS + DEADLINE_SLACK_MS);
    expect(await inflight(raw, organization)).toBe(0);
    expect(await cancelledByDeadline()).toBeGreaterThan(cancelledBefore);
    // The aborted request closes its socket instead of waiting on the service.
    await eventually(async () => proxy.closedClientCount() > closedBefore);
  });

  it('answers 503 AI_SERVICE_UNAVAILABLE at once when the service refuses connections, and releases the permit', async () => {
    const organization = organizationId('refuse');
    const requestsBefore = stubRequests;

    await proxy.setMode('refuse');
    const call = await timed(() => gradedCall(organization));

    expect(rejection(call.result)).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(call.ms).toBeLessThan(DEADLINE_MS);
    expect(stubRequests).toBe(requestsBefore);
    expect(await inflight(raw, organization)).toBe(0);
  });

  it('grades again once the service returns', async () => {
    const organization = organizationId('recover');
    await proxy.setMode('refuse');
    await expect(gradedCall(organization)).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
    });

    await proxy.setMode('normal');
    await eventually(async () => {
      await gradedCall(organization);
      return true;
    });
    expect(await inflight(raw, organization)).toBe(0);
  });
});

describe('a slow AI Service under grading load and client retries', () => {
  // The #327 baseline sustains 8 RPS of mixed grading with a 2 s AI Service.
  // This offers that rate while the service slows to twice its baseline
  // latency, past the request deadline, and every refused client retries.
  // Two Organizations hold 4 permits each, so the 24 calls a 3 s deadline
  // keeps open at 8 RPS cannot all be admitted.
  const OFFERED_RPS = 8;
  const LOAD_SECONDS = 4;
  const ORGANIZATION_PERMITS = 4;
  const LOAD_DEADLINE_MS = 3_000;
  const CIRCUIT_RESET_MS = 30_000;
  const RECOVERY_SECONDS = 2;

  interface Outcome {
    readonly code: string;
    readonly ms: number;
    readonly retryAfterMs: number | undefined;
  }

  async function offer(
    organizations: readonly string[],
    seconds: number,
    retries: number,
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    const attempt = async (organization: string): Promise<void> => {
      for (let tries = 0; tries <= retries; tries += 1) {
        const call = await timed(() =>
          gradedCall(organization, ORGANIZATION_PERMITS, LOAD_DEADLINE_MS),
        );
        const error =
          call.result.status === 'rejected'
            ? (call.result.reason as {
                readonly code?: string;
                readonly retryable?: boolean;
                readonly retryAfterMs?: number;
              })
            : undefined;
        outcomes.push({
          code: error?.code ?? 'OK',
          ms: call.ms,
          retryAfterMs: error?.retryAfterMs,
        });
        if (error?.retryable !== true) return;
        await new Promise((resolve) =>
          setTimeout(resolve, error.retryAfterMs ?? 200),
        );
      }
    };
    const clients: Promise<void>[] = [];
    for (let index = 0; index < OFFERED_RPS * seconds; index += 1) {
      clients.push(attempt(organizations[index % organizations.length] ?? ''));
      await new Promise((resolve) => setTimeout(resolve, 1_000 / OFFERED_RPS));
    }
    await Promise.all(clients);
    return outcomes;
  }

  it('refuses excess work fast with a retry hint, bounds every call by its deadline, keeps the downstream inside the permits, leaks no permit, and recovers', async () => {
    const organizations = [organizationId('load_a'), organizationId('load_b')];
    stubDelayMs = 4_000;
    stubPeakInFlight = 0;

    const overload = await offer(organizations, LOAD_SECONDS, 1);

    const codes = new Set(overload.map(({ code }) => code));
    const refusals = overload.filter(
      ({ code }) => code === 'CONCURRENCY_LIMIT',
    );
    const timeouts = overload.filter(
      ({ code }) => code === 'AI_SERVICE_TIMEOUT',
    );
    // Admitted calls time out by their deadline; excess calls are refused
    // before any downstream call; an open circuit breaker refuses the rest.
    expect([...codes].sort()).toEqual(
      expect.arrayContaining(['AI_SERVICE_TIMEOUT', 'CONCURRENCY_LIMIT']),
    );
    expect(
      [...codes].every((code) =>
        [
          'AI_SERVICE_TIMEOUT',
          'AI_SERVICE_UNAVAILABLE',
          'CONCURRENCY_LIMIT',
        ].includes(code),
      ),
    ).toBe(true);
    expect(Math.max(...refusals.map(({ ms }) => ms))).toBeLessThan(
      REFUSAL_BOUND_MS,
    );
    // The hint is jittered (#403), between the base wait and twice it.
    for (const { retryAfterMs } of refusals) {
      expect(retryAfterMs).toBeGreaterThanOrEqual(CONCURRENCY_RETRY_AFTER_MS);
      expect(retryAfterMs).toBeLessThan(2 * CONCURRENCY_RETRY_AFTER_MS);
    }
    expect(Math.max(...timeouts.map(({ ms }) => ms))).toBeLessThan(
      LOAD_DEADLINE_MS + DEADLINE_SLACK_MS,
    );
    // The service never sees more calls than the Organizations' permits.
    expect(stubPeakInFlight).toBeGreaterThan(0);
    expect(stubPeakInFlight).toBeLessThanOrEqual(
      ORGANIZATION_PERMITS * organizations.length,
    );
    for (const organization of organizations) {
      expect(await inflight(raw, organization)).toBe(0);
    }

    // Once the service is healthy again, an open circuit breaker lets a probe
    // through after its 30 s reset, and the baseline rate is served cleanly.
    stubDelayMs = 0;
    await eventually(async () => {
      await gradedCall(organizations[0] ?? '');
      return true;
    }, CIRCUIT_RESET_MS + 5_000);
    const recovery = await offer(organizations, RECOVERY_SECONDS, 0);

    expect(recovery).toHaveLength(OFFERED_RPS * RECOVERY_SECONDS);
    expect(new Set(recovery.map(({ code }) => code))).toEqual(new Set(['OK']));
    expect(Math.max(...recovery.map(({ ms }) => ms))).toBeLessThan(1_000);
    for (const organization of organizations) {
      expect(await inflight(raw, organization)).toBe(0);
    }
  }, 120_000);
});
