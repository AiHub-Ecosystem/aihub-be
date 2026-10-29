import { Logger } from '@nestjs/common';
import { MockAgent } from 'undici';

import { AppError } from '@/common/errors/app-error';
import { createInternalErrorEnvelope } from '@/common/errors/error-envelope';
import { getMetrics } from '@/common/observability/metrics';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  GradeResponse,
  GradeTask1Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import type {
  DownstreamRetryBudgetDecision,
  DownstreamRetryBudgetPort,
} from '@/modules/gateway/application/downstream-retry-budget.port';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import { DownstreamCircuitBreakers } from '@/modules/gateway/infrastructure/downstream-circuit-breakers';
import { createHttpOperationDispatcher } from '@/modules/gateway/infrastructure/http-operation-dispatcher.testing';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
  DispatchAttemptStart,
} from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { DownstreamHttpClient } from './downstream-http.client';

function fakeGradeAdapter(
  path: string,
  error = new AppError({
    code: 'AI_SERVICE_CONTRACT_VIOLATION',
    message: 'invalid response',
    retryable: false,
  }),
): DownstreamAdapter<GradeTask1Request, GradeResponse> {
  return {
    operation: 'writing.task1.grade',
    downstream: 'ai-writing',
    buildRequest: (input): DownstreamRequest => ({
      method: 'POST',
      path,
      body: {
        question: input.question,
        topic: input.chart_type,
        essay: input.essay,
        url: input.image_url,
      },
    }),
    parseResponse: (): GradeResponse => {
      throw error;
    },
  };
}

const gradeInput: GradeTask1Request = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay.',
  image_url: 'https://example.com/chart.png',
};

const gradeResponse: GradeResponse = {
  overall_band: 7,
  language: 'vi',
  criteria: (
    [
      'task_achievement',
      'task_response',
      'coherence_cohesion',
      'lexical_resource',
    ] satisfies GradeResponse['criteria'][number]['id'][]
  ).map((id) => ({
    id,
    name: id,
    band: 7,
    band_reason: 'clear',
    strengths: [],
    improvements: [],
  })),
  summary: '',
  suggestions: [],
  next_steps: [],
  annotations: [],
};

class FakeTokenIssuer implements InternalTokenIssuerPort {
  constructor(private readonly token = 'token-abc') {}

  mint(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

function fakeDispatchAttempts() {
  const starts: DispatchAttemptStart[] = [];
  const outcomes: Array<{
    readonly attemptId: string;
    readonly outcome: DispatchAttemptOutcome;
  }> = [];
  const recordOutcome = jest.fn(
    async (attemptId: string, outcome: DispatchAttemptOutcome) => {
      outcomes.push({ attemptId, outcome });
    },
  );
  const recorder: DispatchAttemptRecordPort = {
    beginAttempt: jest.fn(async (input) => {
      starts.push(input);
      return 'attempt-test';
    }),
    recordOutcome,
  };
  return { recorder, starts, outcomes };
}

function context(deadlineMs = 5_000, signal?: AbortSignal) {
  return createRequestContext({
    requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    receivedAt: new Date(),
    deadlineMs,
    organizationId: 'org_test',
    scopes: [],
    ...(signal === undefined ? {} : { signal }),
  });
}

function sandboxContext(signal?: AbortSignal) {
  return {
    ...context(5_000, signal),
    organizationId: 'org_sandbox',
    environment: 'sandbox',
  };
}

function fakeSandboxBudget(admitted = true): SandboxDispatchBudgetPort & {
  reserveCalls: unknown[];
  releaseCalls: string[];
} {
  const budget = {
    reserveCalls: [] as unknown[],
    releaseCalls: [] as string[],
    async reserve(input: unknown) {
      this.reserveCalls.push(input);
      return admitted;
    },
    async release(requestId: string) {
      this.releaseCalls.push(requestId);
    },
    async allowanceFor() {
      return {
        monthlyLimit: 5,
        reserved: 0,
        sharedMonthlyLimit: 500,
        sharedReserved: 0,
      };
    },
  };
  return budget;
}

function fakeDownstreamRetryBudget(
  decision: DownstreamRetryBudgetDecision = 'admitted',
) {
  const recordFirstAttempt = jest.fn(
    async (
      _operation: Parameters<
        DownstreamRetryBudgetPort['recordFirstAttempt']
      >[0],
      _requestId: string,
    ) => true,
  );
  const reserveRetry = jest.fn(
    async (
      _operation: Parameters<DownstreamRetryBudgetPort['reserveRetry']>[0],
      _requestId: string,
      _retryNumber: number,
    ): Promise<DownstreamRetryBudgetDecision> => decision,
  );
  const port: DownstreamRetryBudgetPort = {
    isEnabled: () => true,
    expectedAttemptMs: () => 100,
    recordFirstAttempt,
    reserveRetry,
  };
  return { port, recordFirstAttempt, reserveRetry };
}

function readLogLine(loggerError: jest.SpiedFunction<Logger['error']>): string {
  expect(loggerError).toHaveBeenCalledTimes(1);
  const call = loggerError.mock.calls[0];
  expect(call).toHaveLength(1);
  const line: unknown = call?.[0];
  if (typeof line !== 'string') {
    throw new Error('the dispatcher failure log is not a string');
  }
  return line;
}

function isLogPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logPayload(logLine: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(logLine);
  if (!isLogPayload(payload)) {
    throw new Error('the dispatcher failure log is not an object');
  }
  return payload;
}

function expectFailureLogLine(
  logLine: string,
  expected: Record<string, unknown>,
): void {
  const { downstream_ms, ...fields } = logPayload(logLine);
  expect(fields).toEqual(expected);
  expect(typeof downstream_ms).toBe('number');
}

function downstreamMs(logLine: string): number {
  const downstreamMs = logPayload(logLine).downstream_ms;
  if (typeof downstreamMs !== 'number') {
    throw new Error('downstream_ms is missing from the failure log');
  }

  return downstreamMs;
}

async function metricCount(name: string): Promise<number> {
  const prefix = `${name}{operation="writing.task1.grade"} `;
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  return Number(line?.slice(prefix.length) ?? 0);
}

describe('HttpOperationDispatcher', () => {
  let mockAgent: MockAgent;
  let loggerError: jest.SpiedFunction<Logger['error']>;
  let activeCircuitBreakers: DownstreamCircuitBreakers | undefined;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    activeCircuitBreakers?.onModuleDestroy();
    activeCircuitBreakers = undefined;
    await mockAgent.close();
    loggerError.mockRestore();
  });

  it('rejects an operation with no registered adapter instead of silently no-oping', async () => {
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [],
      noOpDispatchAttemptRecord,
    );

    // No interceptor registered at all: if the dispatcher tried to reach the
    // network for the unconfigured operation, `disableNetConnect` would
    // surface that as a network error rather than this config error.
    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', httpStatus: 500 });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('rejects duplicate adapter operations during construction', () => {
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );

    expect(() =>
      createHttpOperationDispatcher(
        httpClient,
        new FakeTokenIssuer(),
        [fakeGradeAdapter('/first'), fakeGradeAdapter('/second')],
        noOpDispatchAttemptRecord,
      ),
    ).toThrow('Duplicate downstream adapter registration');
  });

  it('maps a downstream 5xx to a retryable unified error', async () => {
    const attempts = fakeDispatchAttempts();
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(503, {});
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const cancellationsBefore = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR', retryable: true });

    const logLine = readLogLine(loggerError);
    expectFailureLogLine(logLine, {
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: 503,
      downstream_error_code: null,
      downstream_message: null,
      error_code: 'AI_SERVICE_ERROR',
      message: 'downstream status 503',
    });
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'response_received' },
    ]);
    expect(attempts.starts[0]).toMatchObject({
      requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      organizationId: 'org_test',
      operation: 'writing.task1.grade',
      operationTimeoutMs: 5_000,
    });
    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(cancellationsBefore);
  });

  it('retries a proven pre-send connection failure once and keeps one logical attempt record', async () => {
    const attempts = fakeDispatchAttempts();
    const sandboxBudget = fakeSandboxBudget();
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, { ok: true });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const retryBudget = fakeDownstreamRetryBudget();
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [
        {
          ...fakeGradeAdapter('/task-one'),
          parseResponse: () => gradeResponse,
        },
      ],
      attempts.recorder,
      sandboxBudget,
      retryBudget.port,
      () => 1,
    );

    const timer = jest.spyOn(global, 'setTimeout');
    try {
      await expect(
        dispatcher.dispatch(
          'writing.task1.grade',
          gradeInput,
          sandboxContext(),
        ),
      ).resolves.toMatchObject({ data: gradeResponse });
      expect(timer.mock.calls.some((call) => call[1] === 200)).toBe(true);
    } finally {
      timer.mockRestore();
    }

    expect(retryBudget.recordFirstAttempt).toHaveBeenCalledTimes(1);
    expect(retryBudget.reserveRetry).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map((call) => call[1].requestId)).toEqual([
      'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    ]);
    expect(request.mock.calls[1]?.[1].signal).toBe(
      request.mock.calls[0]?.[1].signal,
    );
    expect(request.mock.calls[1]?.[1].deadlineMs).toBeLessThan(
      request.mock.calls[0]?.[1].deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    expect(attempts.starts).toHaveLength(1);
    expect(sandboxBudget.reserveCalls).toHaveLength(1);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'response_received' },
    ]);
    mockAgent.assertNoPendingInterceptors();
  });

  it('retries 503 once only when Retry-After is valid and within the deadline', async () => {
    const attempts = fakeDispatchAttempts();
    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(503, {}, { headers: { 'retry-after': '0' } });
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, { ok: true });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const retryBudget = fakeDownstreamRetryBudget();
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [
        {
          ...fakeGradeAdapter('/task-one'),
          parseResponse: () => gradeResponse,
        },
      ],
      attempts.recorder,
      undefined,
      retryBudget.port,
      () => 0,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).resolves.toMatchObject({ data: gradeResponse });

    expect(retryBudget.reserveRetry).toHaveBeenCalledWith(
      'writing.task1.grade',
      'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      1,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(attempts.starts).toHaveLength(1);
    mockAgent.assertNoPendingInterceptors();
  });

  it.each([
    ['IMF-fixdate', 'Sun, 06 Nov 1994 08:49:37 GMT'],
    ['obsolete RFC 850 date', 'Sunday, 06-Nov-94 08:49:37 GMT'],
    ['obsolete asctime date', 'Sun Nov  6 08:49:37 1994'],
  ])('accepts an elapsed %s Retry-After date', async (_format, retryAfter) => {
    const attempts = fakeDispatchAttempts();
    const pool = mockAgent.get('https://ai-writing.test');
    pool.intercept({ method: 'POST', path: '/task-one' }).reply(
      503,
      {},
      {
        headers: { 'retry-after': retryAfter },
      },
    );
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, { ok: true });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const retryBudget = fakeDownstreamRetryBudget();
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [
        {
          ...fakeGradeAdapter('/task-one'),
          parseResponse: () => gradeResponse,
        },
      ],
      attempts.recorder,
      undefined,
      retryBudget.port,
      () => 0,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).resolves.toMatchObject({ data: gradeResponse });

    expect(request).toHaveBeenCalledTimes(2);
    mockAgent.assertNoPendingInterceptors();
  });

  it.each(['1.5', 'tomorrow', '99999999999999999999'])(
    'does not retry 503 with invalid Retry-After value %s',
    async (value) => {
      const attempts = fakeDispatchAttempts();
      mockAgent
        .get('https://ai-writing.test')
        .intercept({ method: 'POST', path: '/task-one' })
        .reply(503, {}, { headers: { 'retry-after': value } });
      const httpClient = new DownstreamHttpClient(
        'https://ai-writing.test',
        mockAgent,
      );
      const retryBudget = fakeDownstreamRetryBudget();
      const request = jest.spyOn(httpClient, 'request');
      const dispatcher = createHttpOperationDispatcher(
        httpClient,
        new FakeTokenIssuer(),
        [fakeGradeAdapter('/task-one')],
        attempts.recorder,
        undefined,
        retryBudget.port,
      );

      await expect(
        dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
      ).rejects.toMatchObject({
        code: 'AI_SERVICE_ERROR',
        downstreamStatus: 503,
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
      mockAgent.assertNoPendingInterceptors();
    },
  );

  it.each([400, 500, 502])(
    'does not retry downstream status %i for a POST operation',
    async (status) => {
      const attempts = fakeDispatchAttempts();
      const pool = mockAgent.get('https://ai-writing.test');
      pool.intercept({ method: 'POST', path: '/task-one' }).reply(status, {});
      const httpClient = new DownstreamHttpClient(
        'https://ai-writing.test',
        mockAgent,
      );
      const retryBudget = fakeDownstreamRetryBudget();
      const request = jest.spyOn(httpClient, 'request');
      const dispatcher = createHttpOperationDispatcher(
        httpClient,
        new FakeTokenIssuer(),
        [fakeGradeAdapter('/task-one')],
        attempts.recorder,
        undefined,
        retryBudget.port,
      );

      await expect(
        dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
      ).rejects.toBeInstanceOf(AppError);

      expect(request).toHaveBeenCalledTimes(1);
      expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
      mockAgent.assertNoPendingInterceptors();
    },
  );

  it('returns the original connection error when the per-operation retry budget is spent', async () => {
    const attempts = fakeDispatchAttempts();
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const retryBudget = fakeDownstreamRetryBudget('exhausted');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget.port,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_UNAVAILABLE' });

    expect(retryBudget.reserveRetry).toHaveBeenCalledTimes(1);
    mockAgent.assertNoPendingInterceptors();
  });

  it('checks the breaker again after retry admission and stops before a second send', async () => {
    const attempts = fakeDispatchAttempts();
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const circuitBreakers = (activeCircuitBreakers =
      new DownstreamCircuitBreakers());
    const retryBudget: DownstreamRetryBudgetPort = {
      isEnabled: () => true,
      expectedAttemptMs: () => 100,
      recordFirstAttempt: async () => true,
      async reserveRetry() {
        const failure = new AppError({
          code: 'AI_SERVICE_UNAVAILABLE',
          message: 'AI Service connection refused',
          retryable: true,
        });
        await Promise.all(
          Array.from({ length: 19 }, () =>
            circuitBreakers
              .execute('writing.task1.grade', async () => {
                throw failure;
              })
              .catch(() => undefined),
          ),
        );
        return 'admitted';
      },
    };
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget,
      () => 0,
      circuitBreakers,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(await getMetrics()).toContain(
      'aihub_breaker_state{operation="writing.task1.grade"} 1',
    );
    mockAgent.assertNoPendingInterceptors();
  });

  it('stops after two pre-send connection retries', async () => {
    const attempts = fakeDispatchAttempts();
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    const pool = mockAgent.get('https://ai-writing.test');
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    pool
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const retryBudget = fakeDownstreamRetryBudget();
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget.port,
      () => 0,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_UNAVAILABLE' });

    expect(request).toHaveBeenCalledTimes(3);
    expect(retryBudget.reserveRetry).toHaveBeenCalledTimes(2);
    mockAgent.assertNoPendingInterceptors();
  });

  it('does not retry a connection reset after the request may have been sent', async () => {
    const attempts = fakeDispatchAttempts();
    const reset = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(reset);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const retryBudget = fakeDownstreamRetryBudget();
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget.port,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_UNAVAILABLE' });

    expect(request).toHaveBeenCalledTimes(1);
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
    mockAgent.assertNoPendingInterceptors();
  });

  it('does not retry when Retry-After plus expected attempt time cannot fit the deadline', async () => {
    const attempts = fakeDispatchAttempts();
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(503, {}, { headers: { 'retry-after': '1' } });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const retryBudget = fakeDownstreamRetryBudget();
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget.port,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(1_050)),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_ERROR',
      downstreamStatus: 503,
      retryAfterMs: 1_000,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
    mockAgent.assertNoPendingInterceptors();
  });

  it('cancels a retry backoff when the caller disconnects', async () => {
    const attempts = fakeDispatchAttempts();
    const refused = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(refused);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const controller = new AbortController();
    let signalReservation: (() => void) | undefined;
    const reservationAttempted = new Promise<void>((resolve) => {
      signalReservation = resolve;
    });
    const retryBudget = fakeDownstreamRetryBudget();
    retryBudget.reserveRetry.mockImplementation(async () => {
      signalReservation?.();
      return 'admitted';
    });
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      undefined,
      retryBudget.port,
      () => 1,
    );
    const dispatch = dispatcher.dispatch(
      'writing.task1.grade',
      gradeInput,
      context(5_000, controller.signal),
    );

    await reservationAttempted;
    controller.abort();
    await expect(dispatch).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
    });

    expect(request).toHaveBeenCalledTimes(1);
    mockAgent.assertNoPendingInterceptors();
  });

  it('fails closed and releases sandbox quota when the durable record cannot be created', async () => {
    const attempts = fakeDispatchAttempts();
    attempts.recorder.beginAttempt = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const budget = fakeSandboxBudget();
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      budget,
    );

    const requestContext = sandboxContext();
    const error = await dispatcher
      .dispatch('writing.task1.grade', gradeInput, requestContext)
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).toEnvelope(requestContext.requestId)).toEqual(
      createInternalErrorEnvelope(requestContext.requestId),
    );
    expect(request).not.toHaveBeenCalled();
    expect(budget.releaseCalls).toEqual([requestContext.requestId]);
  });

  it('records a pre-send timeout if the durable write outlasts the operation deadline', async () => {
    const attempts = fakeDispatchAttempts();
    attempts.recorder.beginAttempt = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return 'attempt-test';
    });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const cancellationsBefore = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(100)),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });
    expect(request).not.toHaveBeenCalled();
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'not_dispatched' },
    ]);
    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(cancellationsBefore);
  });

  it('recomputes the outbound timeout after persisting dispatch evidence', async () => {
    const attempts = fakeDispatchAttempts();
    attempts.recorder.beginAttempt = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'attempt-test';
    });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    let sentDeadlineHeader: string | undefined;
    mockAgent
      .get('https://ai-writing.test')
      .intercept({
        method: 'POST',
        path: '/task-one',
        headers: (headers) => {
          sentDeadlineHeader = headers['x-request-deadline'];
          const value = Number(sentDeadlineHeader);
          return Number.isInteger(value) && value > 0 && value < 950;
        },
      })
      .reply(200, { ok: true });
    const send = httpClient.request.bind(httpClient);
    const request = jest.spyOn(httpClient, 'request').mockImplementation(send);
    const histogramBefore = await metricCount(
      'aihub_dispatch_deadline_ms_remaining_count',
    );
    const adapter: DownstreamAdapter<GradeTask1Request, GradeResponse> = {
      ...fakeGradeAdapter('/task-one'),
      parseResponse: () => gradeResponse,
    };
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [adapter],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(1_000)),
    ).resolves.toMatchObject({ data: { overall_band: 7 } });

    const deadlineMs = request.mock.calls[0]?.[1].deadlineMs;
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThan(950);
    expect(Number(sentDeadlineHeader)).toBe(deadlineMs);
    expect(
      await metricCount('aihub_dispatch_deadline_ms_remaining_count'),
    ).toBe(histogramBefore + 1);
  });

  it('counts an in-flight call aborted by the work deadline', async () => {
    const attempts = fakeDispatchAttempts();
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    jest.spyOn(httpClient, 'request').mockImplementation(
      (_request, options) =>
        new Promise((_, reject) => {
          const rejectOnAbort = () =>
            reject(
              new AppError({
                code: 'AI_SERVICE_TIMEOUT',
                message: 'AI service request timed out',
                retryable: true,
              }),
            );
          options.signal.addEventListener('abort', rejectOnAbort, {
            once: true,
          });
          if (options.signal.aborted) rejectOnAbort();
        }),
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const before = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(100)),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(before + 1);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'outcome_unknown' },
    ]);
  });

  it('does not count a caller disconnect as a deadline cancellation', async () => {
    const attempts = fakeDispatchAttempts();
    const abort = new AbortController();
    let startedRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      startedRequest = resolve;
    });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    jest.spyOn(httpClient, 'request').mockImplementation(
      (_request, options) =>
        new Promise((_, reject) => {
          const rejectOnAbort = () =>
            reject(
              new AppError({
                code: 'AI_SERVICE_TIMEOUT',
                message: 'AI service request timed out',
                retryable: true,
              }),
            );
          options.signal.addEventListener('abort', rejectOnAbort, {
            once: true,
          });
          startedRequest();
          if (options.signal.aborted) rejectOnAbort();
        }),
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const before = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );
    const pending = dispatcher.dispatch(
      'writing.task1.grade',
      gradeInput,
      context(5_000, abort.signal),
    );
    await requestStarted;
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(before);
  });

  it('does not count a deadline abort after a downstream error response', async () => {
    const attempts = fakeDispatchAttempts();
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    jest.spyOn(httpClient, 'request').mockImplementation(
      (_request, options) =>
        new Promise((_, reject) => {
          options.onResponseReceived?.(503);
          const rejectOnAbort = () =>
            reject(
              new AppError({
                code: 'AI_SERVICE_TIMEOUT',
                message: 'AI service request timed out',
                retryable: true,
              }),
            );
          options.signal.addEventListener('abort', rejectOnAbort, {
            once: true,
          });
          if (options.signal.aborted) rejectOnAbort();
        }),
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const before = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(100)),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(before);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'response_received' },
    ]);
  });

  it('keeps a downstream success when recording its known outcome fails', async () => {
    const attempts = fakeDispatchAttempts();
    const recordOutcome = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    attempts.recorder.recordOutcome = recordOutcome;
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, { ok: true });
    const successfulAdapter: DownstreamAdapter<
      GradeTask1Request,
      GradeResponse
    > = {
      operation: 'writing.task1.grade',
      downstream: 'ai-writing',
      buildRequest: (input) => ({
        method: 'POST',
        path: '/task-one',
        body: input,
      }),
      parseResponse: () => gradeResponse,
    };
    const dispatcher = createHttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', mockAgent),
      new FakeTokenIssuer(),
      [successfulAdapter],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).resolves.toMatchObject({ data: { overall_band: 7 } });
    expect(recordOutcome.mock.calls).toContainEqual([
      'attempt-test',
      'response_received',
    ]);
  });

  it('releases a reservation when local downstream configuration proves the request was not sent', async () => {
    const attempts = fakeDispatchAttempts();
    const budget = fakeSandboxBudget();
    const httpClient = new DownstreamHttpClient('', mockAgent);
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
      budget,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, sandboxContext()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    expect(budget.reserveCalls).toEqual([
      {
        organizationId: 'org_sandbox',
        requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      },
    ]);
    expect(budget.releaseCalls).toEqual(['req_01J8QK3M7XW2P5NRTVA9BCDEFG']);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'not_dispatched' },
    ]);
  });

  it('does not reserve quota when the request is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const budget = fakeSandboxBudget();
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
      budget,
    );

    await expect(
      dispatcher.dispatch(
        'writing.task1.grade',
        gradeInput,
        sandboxContext(abort.signal),
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    expect(budget.reserveCalls).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(budget.releaseCalls).toEqual([]);
  });

  it('releases quota when the request aborts while admission is pending', async () => {
    const abort = new AbortController();
    const budget = fakeSandboxBudget();
    jest.spyOn(budget, 'reserve').mockImplementation(async (input) => {
      budget.reserveCalls.push(input);
      abort.abort();
      return true;
    });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
      budget,
    );

    await expect(
      dispatcher.dispatch(
        'writing.task1.grade',
        gradeInput,
        sandboxContext(abort.signal),
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

    expect(request).not.toHaveBeenCalled();
    expect(budget.releaseCalls).toEqual(['req_01J8QK3M7XW2P5NRTVA9BCDEFG']);
  });

  it('consumes a reservation when a downstream response proves dispatch occurred', async () => {
    const budget = fakeSandboxBudget();
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(503, {});
    const dispatcher = createHttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', mockAgent),
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
      budget,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, sandboxContext()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR' });

    expect(budget.releaseCalls).toEqual([]);
  });

  it('fails before calling downstream when durable monthly admission denies a reservation', async () => {
    const budget = fakeSandboxBudget(false);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
      budget,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, sandboxContext()),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', httpStatus: 429 });

    expect(request).not.toHaveBeenCalled();
    expect(budget.releaseCalls).toEqual([]);
  });

  it('maps a downstream 429 to the throttled error, not the client rate-limit error', async () => {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(429, {});
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_THROTTLED', httpStatus: 503 });

    const logLine = readLogLine(loggerError);
    expectFailureLogLine(logLine, {
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: 429,
      downstream_error_code: null,
      downstream_message: null,
      error_code: 'AI_SERVICE_THROTTLED',
      message: 'downstream status 429',
    });
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
  });

  async function dispatchAfterDownstreamStatus(status: number) {
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(status, {});
    const dispatcher = createHttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', mockAgent),
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
    );
    return dispatcher.dispatch('writing.task1.grade', gradeInput, context());
  }

  async function credentialFailureCount(): Promise<number> {
    const prefix =
      'aihub_downstream_credential_failures_total{operation="writing.task1.grade",downstream="ai-writing"} ';
    const line = (await getMetrics())
      .split('\n')
      .find((candidate) => candidate.startsWith(prefix));
    return Number(line?.slice(prefix.length) ?? 0);
  }

  // The AI Service rejecting AIHUB's own credential is an AIHUB fault, not the
  // customer's input (#845). The customer sees the same unavailable answer a
  // connection failure gives; only the log and the counter say why.
  it.each([401, 403])(
    'maps a downstream %i to a retryable unavailable error and records a credential rejection',
    async (status) => {
      const before = await credentialFailureCount();

      await expect(dispatchAfterDownstreamStatus(status)).rejects.toMatchObject(
        {
          code: 'AI_SERVICE_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          downstreamStatus: status,
        },
      );

      expectFailureLogLine(readLogLine(loggerError), {
        event: 'downstream_credential_rejected',
        request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
        operation: 'writing.task1.grade',
        ai_service: 'ai-writing',
        private_endpoint: '/task-one',
        downstream_status: status,
        downstream_error_code: null,
        downstream_message: null,
        error_code: 'AI_SERVICE_UNAVAILABLE',
        message: `downstream status ${status}`,
      });
      expect(await credentialFailureCount()).toBe(before + 1);
    },
  );

  it.each([408, 425])(
    'maps a downstream %i to a retryable error and records no credential rejection',
    async (status) => {
      const before = await credentialFailureCount();

      await expect(dispatchAfterDownstreamStatus(status)).rejects.toMatchObject(
        {
          code: 'AI_SERVICE_ERROR',
          httpStatus: 502,
          retryable: true,
          downstreamStatus: status,
        },
      );

      expect(logPayload(readLogLine(loggerError)).event).toBe(
        'downstream_failed',
      );
      expect(await credentialFailureCount()).toBe(before);
    },
  );

  it.each([400, 404, 413, 415, 422])(
    'keeps a downstream %i a non-retryable error',
    async (status) => {
      await expect(dispatchAfterDownstreamStatus(status)).rejects.toMatchObject(
        {
          code: 'AI_SERVICE_ERROR',
          httpStatus: 502,
          retryable: false,
          downstreamStatus: status,
        },
      );
    },
  );

  it('logs an aborted downstream request as a timeout without a response status', async () => {
    const originalError = new AppError({
      code: 'AI_SERVICE_TIMEOUT',
      message: 'AI service request timed out',
      retryable: true,
      cause: new Error('private timeout cause'),
    });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    jest.spyOn(httpClient, 'request').mockRejectedValue(originalError);
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toBe(originalError);

    const logLine = readLogLine(loggerError);
    expectFailureLogLine(logLine, {
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: null,
      downstream_error_code: null,
      downstream_message: null,
      error_code: 'AI_SERVICE_TIMEOUT',
      message: 'downstream timed out',
    });
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
  });

  it('logs a transport failure as unavailable without leaking its cause', async () => {
    const attempts = fakeDispatchAttempts();
    const transportMarker = 'private transport failure marker';
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .replyWithError(new Error(transportMarker));
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );
    const cancellationsBefore = await metricCount(
      'aihub_dispatch_cancelled_by_deadline_total',
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
    });

    const logLine = readLogLine(loggerError);
    expectFailureLogLine(logLine, {
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: null,
      downstream_error_code: null,
      downstream_message: null,
      error_code: 'AI_SERVICE_UNAVAILABLE',
      message: 'downstream unreachable',
    });
    expect(logLine).not.toContain(transportMarker);
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'outcome_unknown' },
    ]);
    expect(
      await metricCount('aihub_dispatch_cancelled_by_deadline_total'),
    ).toBe(cancellationsBefore);
  });

  it('records a received HTTP response when its body cannot be parsed', async () => {
    const attempts = fakeDispatchAttempts();
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, 'not-json');
    const dispatcher = createHttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', mockAgent),
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });

    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'response_received' },
    ]);
    expect(JSON.parse(readLogLine(loggerError))).toMatchObject({
      downstream_status: 200,
      error_code: 'AI_SERVICE_CONTRACT_VIOLATION',
    });
  });

  it('logs an adapter contract violation once without serializing request, token, or response content', async () => {
    const essayMarker = 'private essay marker';
    const tokenMarker = 'private internal token marker';
    const responseMarker = 'private raw response marker';
    const originalError = new AppError({
      code: 'AI_SERVICE_CONTRACT_VIOLATION',
      message: 'AI service returned an unexpected response shape',
      retryable: false,
      cause: new Error(
        `unexpected criterion contains ${responseMarker} and ${essayMarker}`,
      ),
    });
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/grade' })
      .reply(200, { unexpected: responseMarker });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(tokenMarker),
      [fakeGradeAdapter('/grade', originalError)],
      noOpDispatchAttemptRecord,
    );

    await expect(
      dispatcher.dispatch(
        'writing.task1.grade',
        {
          question: 'question marker',
          chart_type: 'Bar Chart',
          essay: essayMarker,
          image_url: 'https://example.com/chart.png',
        },
        context(),
      ),
    ).rejects.toBe(originalError);

    const logLine = readLogLine(loggerError);
    expectFailureLogLine(logLine, {
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/grade',
      downstream_status: 200,
      downstream_error_code: null,
      downstream_message: null,
      error_code: 'AI_SERVICE_CONTRACT_VIOLATION',
      message: 'downstream response failed contract validation',
    });
    expect(logLine).not.toContain(essayMarker);
    expect(logLine).not.toContain(tokenMarker);
    expect(logLine).not.toContain(responseMarker);
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
  });

  describe('a contract violation that carries a diagnostic', () => {
    async function dispatchViolation(error: AppError): Promise<string> {
      mockAgent
        .get('https://ai-writing.test')
        .intercept({ method: 'POST', path: '/grade' })
        .reply(200, { unexpected: true });
      const dispatcher = createHttpOperationDispatcher(
        new DownstreamHttpClient('https://ai-writing.test', mockAgent),
        new FakeTokenIssuer('token'),
        [fakeGradeAdapter('/grade', error)],
        noOpDispatchAttemptRecord,
      );

      await expect(
        dispatcher.dispatch(
          'writing.task1.grade',
          {
            question: 'question marker',
            chart_type: 'Bar Chart',
            essay: 'essay marker',
            image_url: 'https://example.com/chart.png',
          },
          context(),
        ),
      ).rejects.toBe(error);
      return readLogLine(loggerError);
    }

    it('logs it as the reason, and still never logs the cause', async () => {
      const causeMarker = 'private cause marker';
      const logLine = await dispatchViolation(
        new AppError({
          code: 'AI_SERVICE_CONTRACT_VIOLATION',
          message: 'AI service returned an unexpected response shape',
          retryable: false,
          diagnostic:
            '/pronunciation_detail/words/3/syllables/1/predicted_stress (Integer)',
          cause: new Error(`contains ${causeMarker}`),
        }),
      );

      expect(logPayload(logLine)).toMatchObject({
        error_code: 'AI_SERVICE_CONTRACT_VIOLATION',
        reason:
          '/pronunciation_detail/words/3/syllables/1/predicted_stress (Integer)',
      });
      expect(logLine).not.toContain(causeMarker);
    });

    it('caps the reason, so an adapter cannot flood the log', async () => {
      const logLine = await dispatchViolation(
        new AppError({
          code: 'AI_SERVICE_CONTRACT_VIOLATION',
          message: 'AI service returned an unexpected response shape',
          retryable: false,
          diagnostic: 'x'.repeat(5_000),
        }),
      );

      expect(logPayload(logLine).reason).toHaveLength(400);
    });

    it('omits the reason when the error carries none', async () => {
      const logLine = await dispatchViolation(
        new AppError({
          code: 'AI_SERVICE_CONTRACT_VIOLATION',
          message: 'AI service returned an unexpected response shape',
          retryable: false,
        }),
      );

      expect(logPayload(logLine)).not.toHaveProperty('reason');
    });
  });
});
