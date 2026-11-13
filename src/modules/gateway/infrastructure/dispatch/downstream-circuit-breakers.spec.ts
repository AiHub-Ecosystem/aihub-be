import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockAgent } from 'undici/index.js';

import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { setDownstreamBreakerState } from '@/common/observability/downstream-breaker-metrics';
import { getMetrics } from '@/common/observability/metrics';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';
import { DownstreamCircuitBreakers } from './downstream-circuit-breakers';
import { DownstreamHttpClient } from './downstream-http.client';
import { GRADIENT2_DEFAULT_CONFIG } from './gradient2-concurrency-limiter';

const OK: InternalAIServiceResponse<unknown> = {
  status: 200,
  headers: {},
  body: {},
};

async function breakerState(operation: string): Promise<string | undefined> {
  const prefix = `aihub_breaker_state{operation="${operation}"} `;
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
}

async function listenOnLoopback(
  server: ReturnType<typeof createServer>,
): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function executeTwentyTransportFailures(
  client: DownstreamHttpClient,
  circuitBreakers: DownstreamCircuitBreakers,
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await circuitBreakers
      .execute('writing.task1.grade', () =>
        client.request(
          { method: 'POST', path: '/grade', body: {} },
          {
            requestId: `req_transport_${index}`,
            deadlineMs: 5_000,
            signal: AbortSignal.timeout(5_000),
          },
        ),
      )
      .catch(() => undefined);
  }
}

async function ignoreFailure(
  breakers: DownstreamCircuitBreakers,
  operation: 'writing.task1.grade' | 'writing.task2.grade' | 'speaking.grading',
  error: AppError,
): Promise<void> {
  await breakers
    .execute(operation, async () => {
      throw error;
    })
    .catch(() => undefined);
}

describe('DownstreamCircuitBreakers', () => {
  let breakers: DownstreamCircuitBreakers | undefined;

  afterEach(() => {
    breakers?.onModuleDestroy();
    breakers = undefined;
    jest.useRealTimers();
  });

  it('does not export metric labels for operations outside the catalog', async () => {
    setDownstreamBreakerState('unregistered.operation' as OperationId, 1);

    expect(await getMetrics()).not.toContain(
      'operation="unregistered.operation"',
    );
  });

  it('opens only the affected operation after concurrent failures', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const failure = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'provider failed',
      retryable: true,
      downstreamStatus: 503,
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        ignoreFailure(instance, 'writing.task1.grade', failure),
      ),
    );
    expect(await breakerState('writing.task1.grade')).toBe('1');
    await expect(
      instance.execute('writing.task2.grade', async () => OK),
    ).resolves.toBe(OK);

    expect(await breakerState('writing.task1.grade')).toBe('1');
    expect(await breakerState('writing.task2.grade')).toBe('0');
  });

  // A rejected AIHUB credential fails every request, so the breaker opens; a
  // 408 or 425 says nothing about the service (#845).
  it.each([
    [401, 'AI_SERVICE_UNAVAILABLE', '1'],
    [403, 'AI_SERVICE_UNAVAILABLE', '1'],
    [408, 'AI_SERVICE_ERROR', '0'],
    [425, 'AI_SERVICE_ERROR', '0'],
  ] as const)(
    'a downstream %i answered as %s leaves the breaker state at %s',
    async (status, code, state) => {
      const instance = (breakers = new DownstreamCircuitBreakers());
      const failure = new AppError({
        code,
        message: 'downstream answered',
        retryable: true,
        downstreamStatus: status,
      });

      await Promise.all(
        Array.from({ length: 20 }, () =>
          ignoreFailure(instance, 'writing.task1.grade', failure),
        ),
      );

      expect(await breakerState('writing.task1.grade')).toBe(state);
    },
  );

  it('does not open before 20 calls in the rolling window', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const failure = new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    });

    for (let index = 0; index < 19; index += 1) {
      await ignoreFailure(instance, 'writing.task1.grade', failure);
    }

    expect(await breakerState('writing.task1.grade')).toBe('0');
  });

  it('counts downstream timeouts as service failures', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const timeout = new AppError({
      code: 'AI_SERVICE_TIMEOUT',
      message: 'downstream timed out',
      retryable: true,
    });

    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(instance, 'writing.task1.grade', timeout);
    }

    expect(await breakerState('writing.task1.grade')).toBe('1');
  });

  it.each([
    ['Gradient2 limit', GRADIENT2_DEFAULT_CONFIG, 10],
    [
      'hard ceiling',
      {
        ...GRADIENT2_DEFAULT_CONFIG,
        initialLimit: 20,
        minLimit: 20,
        maxLimit: 20,
      },
      20,
    ],
  ] as const)(
    'keeps %s refusals out of the breaker failure count',
    async (_limitName, config, admittedLimit) => {
      const requestCount = admittedLimit * 3;
      let serverRequestCount = 0;
      let releaseResponses!: () => void;
      let resolveActionsStarted!: () => void;
      let resolveServerRequests!: () => void;
      let resolveRefusalsObserved!: () => void;
      let actionsStarted = 0;
      const refusalErrors: AppError[] = [];
      const responsesReleased = new Promise<void>((resolve) => {
        releaseResponses = resolve;
      });
      const allActionsStarted = new Promise<void>((resolve) => {
        resolveActionsStarted = resolve;
      });
      const allServerRequests = new Promise<void>((resolve) => {
        resolveServerRequests = resolve;
      });
      const expectedRefusals = requestCount - admittedLimit;
      const refusalsObserved = new Promise<void>((resolve) => {
        resolveRefusalsObserved = resolve;
      });
      const server = createServer((_request, response) => {
        serverRequestCount += 1;
        if (serverRequestCount === admittedLimit) resolveServerRequests();
        void responsesReleased.then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end('{}');
        });
      });
      const origin = await listenOnLoopback(server);
      const client = new DownstreamHttpClient(origin, undefined, {}, config);
      const circuitBreakers = (breakers = new DownstreamCircuitBreakers());
      let releaseActions!: () => void;
      const actionsReleased = new Promise<void>((resolve) => {
        releaseActions = resolve;
      });
      const request = () =>
        client.request(
          { method: 'POST', path: '/grade', body: {} },
          {
            downstream: 'ai-writing',
            requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
            deadlineMs: 30_000,
            signal: AbortSignal.timeout(30_000),
          },
        );
      const calls = Array.from({ length: requestCount }, () =>
        circuitBreakers
          .execute('writing.task1.grade', async () => {
            actionsStarted += 1;
            if (actionsStarted === requestCount) resolveActionsStarted();
            await actionsReleased;
            return request();
          })
          .catch((error: unknown) => {
            if (error instanceof AppError) {
              refusalErrors.push(error);
              if (refusalErrors.length === expectedRefusals) {
                resolveRefusalsObserved();
              }
            }
          }),
      );

      try {
        await allActionsStarted;
        releaseActions();
        await Promise.all([refusalsObserved, allServerRequests]);

        expect(serverRequestCount).toBe(admittedLimit);
        expect(refusalErrors).toHaveLength(expectedRefusals);
        expect(refusalErrors[0]).toMatchObject({
          code: 'AI_SERVICE_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          diagnostic: 'ai_service:bulkhead_exhausted',
        });
        expect(refusalErrors[0]?.toEnvelope('req_test')).toMatchObject({
          error: { code: 'AI_SERVICE_UNAVAILABLE', retryable: true },
        });
        expect(await breakerState('writing.task1.grade')).toBe('0');
        expect(await getMetrics()).toContain(
          `aihub_downstream_limit_dropped_total{origin="${origin}"} ${expectedRefusals}`,
        );

        releaseResponses();
        await Promise.all(calls);
        await expect(
          circuitBreakers.execute('writing.task1.grade', request),
        ).resolves.toMatchObject({ status: 200 });
        expect(serverRequestCount).toBe(admittedLimit + 1);
        expect(await breakerState('writing.task1.grade')).toBe('0');
      } finally {
        releaseActions();
        releaseResponses();
        await Promise.all(calls);
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('counts a pre-send connection refusal as a breaker failure', async () => {
    const server = createServer();
    const origin = await listenOnLoopback(server);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const client = new DownstreamHttpClient(origin);
    const circuitBreakers = (breakers = new DownstreamCircuitBreakers());

    try {
      await executeTwentyTransportFailures(client, circuitBreakers);
      expect(await breakerState('writing.task1.grade')).toBe('1');
    } finally {
      await client.close();
    }
  });

  it.each([
    ['DNS failure', 'ENOTFOUND'],
    ['connect timeout', 'UND_ERR_CONNECT_TIMEOUT'],
  ] as const)(
    'counts a pre-send %s as a breaker failure',
    async (_failureType, code) => {
      const origin = 'https://ai-writing.test';
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      const pool = mockAgent.get(origin);
      for (let index = 0; index < 20; index += 1) {
        pool
          .intercept({ method: 'POST', path: '/grade' })
          .replyWithError(
            Object.assign(new Error('connection failed'), { code }),
          );
      }
      const client = new DownstreamHttpClient(origin, mockAgent);
      const circuitBreakers = (breakers = new DownstreamCircuitBreakers());

      try {
        await executeTwentyTransportFailures(client, circuitBreakers);
        expect(await breakerState('writing.task1.grade')).toBe('1');
        mockAgent.assertNoPendingInterceptors();
      } finally {
        await client.close();
      }
    },
  );

  it('does not count downstream 4xx responses as service failures', async () => {
    breakers = new DownstreamCircuitBreakers();
    const invalidRequest = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'invalid downstream request',
      retryable: false,
      downstreamStatus: 400,
    });

    for (let index = 0; index < 25; index += 1) {
      await ignoreFailure(breakers, 'writing.task1.grade', invalidRequest);
    }

    expect(await breakerState('writing.task1.grade')).toBe('0');
  });

  it('does not count the captured unreadable-audio client error from a provider 500', async () => {
    const instance = (breakers = new DownstreamCircuitBreakers());
    const unreadableAudio = new AppError({
      code: 'AUDIO_UNREADABLE',
      message: 'The audio could not be read',
      retryable: false,
      downstreamStatus: 500,
    });

    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(instance, 'speaking.grading', unreadableAudio);
    }

    expect(await breakerState('speaking.grading')).toBe('0');
  });

  it('admits one half-open probe and returns the retry hint for blocked calls', async () => {
    jest.useFakeTimers();
    breakers = new DownstreamCircuitBreakers();
    const failure = new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'unavailable',
      retryable: true,
    });
    for (let index = 0; index < 20; index += 1) {
      await ignoreFailure(breakers, 'writing.task1.grade', failure);
    }
    expect(await breakerState('writing.task1.grade')).toBe('1');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(await breakerState('writing.task1.grade')).toBe('2');

    let completeProbe:
      | ((response: InternalAIServiceResponse<unknown>) => void)
      | undefined;
    const probe = breakers.execute(
      'writing.task1.grade',
      () =>
        new Promise((resolve) => {
          completeProbe = resolve;
        }),
    );
    const blocked = await breakers
      .execute('writing.task1.grade', async () => OK)
      .catch((error: unknown) => error);

    expect(blocked).toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(await breakerState('writing.task1.grade')).toBe('2');
    completeProbe?.(OK);
    await expect(probe).resolves.toBe(OK);
    expect(await breakerState('writing.task1.grade')).toBe('0');
  });
});
