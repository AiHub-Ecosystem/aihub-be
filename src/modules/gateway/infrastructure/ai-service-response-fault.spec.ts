import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, createServer } from 'node:http';

import type { GradeTask2Request } from '@/contracts/writing/grading';
import { task2GradeAdapter } from '@/downstream/writing/task2-grade.adapter';
import type { OperationDispatcherPort } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import { DownstreamCircuitBreakers } from '@/modules/gateway/infrastructure/dispatch/downstream-circuit-breakers';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/dispatch/downstream-http.client';
import { GRADIENT2_DEFAULT_CONFIG } from '@/modules/gateway/infrastructure/dispatch/gradient2-concurrency-limiter';
import { createHttpOperationDispatcher } from '../../../../test/support/gateway/http-operation-dispatcher.testing';

import {
  eventually,
  metricValue,
  rejection,
  timed,
} from '../../../../test/support/fault-timing';

// The AI Service answers, but with a status or body the matrix maps to a
// client error (#2019, 14-degraded-mode-matrix.md "AI Services" rows).
const OPERATION = 'writing.task2.grade' as const;
const DEADLINE_MS = 600;
// A refusal is decided before any downstream call, so it is fast.
const REFUSAL_BOUND_MS = 300;
// opossum's volume threshold in downstream-circuit-breakers.ts.
const BREAKER_VOLUME = 20;

const GRADING_INPUT: GradeTask2Request = {
  question: 'Some people think schools should teach coding. Discuss.',
  topic: 'education',
  essay: 'A short essay.',
};

interface StubAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent verbatim, so a test can send a body that is not JSON. */
  readonly body: string;
}

let stub: Server;
let stubUrl: string;
let stubRequests = 0;
// `undefined` holds every request open, like a hung service.
let answer: StubAnswer | undefined;
let httpClient: DownstreamHttpClient;
let breakers: DownstreamCircuitBreakers;
let dispatcher: OperationDispatcherPort;

function grade(): Promise<unknown> {
  return dispatcher.dispatch(OPERATION, GRADING_INPUT, {
    requestId: `req_${randomUUID()}`,
    receivedAt: new Date(),
    deadlineAt: new Date(Date.now() + DEADLINE_MS),
    operationTimeoutMs: DEADLINE_MS,
    organizationId: `org_ai_response_${randomUUID().replaceAll('-', '')}`,
    scopes: [],
    signal: new AbortController().signal,
  });
}

function json(status: number, body: unknown, headers = {}): StubAnswer {
  return { status, headers, body: JSON.stringify(body) };
}

beforeAll(async () => {
  stub = createServer((request, response) => {
    stubRequests += 1;
    request.resume();
    request.on('end', () => {
      if (answer === undefined) return;
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        ...answer.headers,
      });
      response.end(answer.body);
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const address = stub.address();
  if (address === null || typeof address === 'string') {
    throw new Error('AI Service stub did not bind');
  }
  stubUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  // A fresh client, limiter, and breaker per test, so one test's failures
  // never shape the admission another test sees.
  httpClient = new DownstreamHttpClient(stubUrl);
  breakers = new DownstreamCircuitBreakers();
  dispatcher = createHttpOperationDispatcher(
    httpClient,
    { mint: async () => 'internal-token' },
    [task2GradeAdapter],
    {
      beginAttempt: async () => `attempt_${randomUUID()}`,
      recordOutcome: async () => undefined,
    },
    undefined,
    undefined,
    Math.random,
    breakers,
  );
});

afterEach(async () => {
  answer = undefined;
  breakers.onModuleDestroy();
  await httpClient.close();
});

afterAll(() => {
  stub.closeAllConnections();
  stub.close();
});

describe('AI Service answers the matrix maps to a client error', () => {
  it.each([401, 403])(
    'answers %s as a retryable 503 AI_SERVICE_UNAVAILABLE and counts a credential failure',
    async (status) => {
      const labels = { operation: OPERATION, downstream: 'ai-writing' };
      const before = await metricValue(
        'aihub_downstream_credential_failures_total',
        labels,
      );
      answer = json(status, { detail: 'rejected' });

      expect(rejection((await timed(grade)).result)).toMatchObject({
        code: 'AI_SERVICE_UNAVAILABLE',
        httpStatus: 503,
        retryable: true,
      });
      expect(
        await metricValue('aihub_downstream_credential_failures_total', labels),
      ).toBe(before + 1);
    },
  );

  it('answers 429 as a retryable 503 AI_SERVICE_THROTTLED that keeps the provider retry hint', async () => {
    answer = json(429, { detail: 'slow down' }, { 'retry-after': '7' });

    expect(rejection((await timed(grade)).result)).toMatchObject({
      code: 'AI_SERVICE_THROTTLED',
      httpStatus: 503,
      retryable: true,
      retryAfterMs: 7_000,
    });
  });

  it.each([500, 502, 503, 408, 425])(
    'answers %s as a retryable 502 AI_SERVICE_ERROR',
    async (status) => {
      answer = json(status, { detail: 'failed' });

      expect(rejection((await timed(grade)).result)).toMatchObject({
        code: 'AI_SERVICE_ERROR',
        httpStatus: 502,
        retryable: true,
      });
    },
  );

  it.each([400, 404, 422])(
    'answers %s as a non-retryable 502 AI_SERVICE_ERROR',
    async (status) => {
      answer = json(status, { detail: 'bad request' });

      expect(rejection((await timed(grade)).result)).toMatchObject({
        code: 'AI_SERVICE_ERROR',
        httpStatus: 502,
        retryable: false,
      });
    },
  );

  it.each<[string, StubAnswer]>([
    ['a body missing the graded fields', json(200, { success: true })],
    ['a body that is not JSON', { status: 200, body: '<html>oops</html>' }],
  ])(
    'answers %s as a non-retryable 502 AI_SERVICE_CONTRACT_VIOLATION',
    async (_label, invalid) => {
      answer = invalid;

      expect(rejection((await timed(grade)).result)).toMatchObject({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        httpStatus: 502,
        retryable: false,
      });
    },
  );
});

describe('AI Service breaker and bulkhead refusals', () => {
  it('opens the breaker after the failure threshold and refuses at once without calling the service', async () => {
    answer = json(500, { detail: 'failed' });
    for (let index = 0; index < BREAKER_VOLUME; index += 1) {
      await expect(grade()).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR' });
    }
    expect(
      await metricValue('aihub_breaker_state', { operation: OPERATION }),
    ).toBe(1);
    const requestsBefore = stubRequests;

    const refused = await timed(grade);

    expect(rejection(refused.result)).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(refused.ms).toBeLessThan(REFUSAL_BOUND_MS);
    expect(stubRequests).toBe(requestsBefore);
  });

  it('keeps the breaker closed through ordinary 4xx answers', async () => {
    answer = json(422, { detail: 'bad request' });
    for (let index = 0; index < BREAKER_VOLUME + 5; index += 1) {
      await expect(grade()).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR' });
    }
    const requestsBefore = stubRequests;

    await expect(grade()).rejects.toMatchObject({
      code: 'AI_SERVICE_ERROR',
      retryable: false,
    });
    expect(stubRequests).toBe(requestsBefore + 1);
    expect(
      await metricValue('aihub_breaker_state', { operation: OPERATION }),
    ).toBe(0);
  });

  it('refuses past the per-origin bulkhead at once with a retryable 503 and counts the drop', async () => {
    const limit = GRADIENT2_DEFAULT_CONFIG.initialLimit;
    const droppedBefore = await metricValue(
      'aihub_downstream_limit_dropped_total',
      { origin: stubUrl },
    );
    const requestsBefore = stubRequests;
    const held = Array.from({ length: limit }, () => timed(grade));
    await eventually(async () => stubRequests === requestsBefore + limit);

    const refused = await timed(grade);

    expect(rejection(refused.result)).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    expect(refused.ms).toBeLessThan(REFUSAL_BOUND_MS);
    expect(stubRequests).toBe(requestsBefore + limit);
    expect(
      await metricValue('aihub_downstream_limit_dropped_total', {
        origin: stubUrl,
      }),
    ).toBe(droppedBefore + 1);
    // The held calls end at their deadline and free their slots.
    for (const call of await Promise.all(held)) {
      expect(rejection(call.result)).toMatchObject({
        code: 'AI_SERVICE_TIMEOUT',
      });
    }
  });
});
