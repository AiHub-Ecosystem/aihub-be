import { Logger } from '@nestjs/common';
import { MockAgent } from 'undici';

import { AppError } from '@/common/errors/app-error';
import { createInternalErrorEnvelope } from '@/common/errors/error-envelope';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  GradeResponse,
  GradeTask1Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
  DispatchAttemptStart,
} from '@/modules/metering/public/dispatch-attempts';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { DownstreamHttpClient } from './downstream-http.client';
import { HttpOperationDispatcher } from './http-operation-dispatcher';

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
  const recorder: DispatchAttemptRecordPort = {
    beginAttempt: jest.fn(async (input) => {
      starts.push(input);
      return 'attempt-test';
    }),
    recordOutcome: jest.fn(async (attemptId, outcome) => {
      outcomes.push({ attemptId, outcome });
    }),
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
    sandboxOrganizationDispatchLimit: 25,
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
  };
  return budget;
}

function readLogLine(loggerError: jest.SpiedFunction<Logger['error']>): string {
  expect(loggerError).toHaveBeenCalledTimes(1);
  const call = loggerError.mock.calls[0];
  expect(call).toHaveLength(1);
  const line = call?.[0];
  expect(typeof line).toBe('string');
  return String(line);
}

function downstreamMs(logLine: string): number {
  const payload: unknown = JSON.parse(logLine);
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('downstream_ms' in payload) ||
    typeof payload.downstream_ms !== 'number'
  ) {
    throw new Error('downstream_ms is missing from the failure log');
  }

  return payload.downstream_ms;
}

describe('HttpOperationDispatcher', () => {
  let mockAgent: MockAgent;
  let loggerError: jest.SpiedFunction<Logger['error']>;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await mockAgent.close();
    loggerError.mockRestore();
  });

  it('rejects an operation with no registered adapter instead of silently no-oping', async () => {
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_ERROR', retryable: true });

    const logLine = readLogLine(loggerError);
    expect(JSON.parse(logLine)).toEqual({
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: 503,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: expect.any(Number),
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
  });

  it('fails closed with the existing internal error envelope when the durable record cannot be created', async () => {
    const attempts = fakeDispatchAttempts();
    attempts.recorder.beginAttempt = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const request = jest.spyOn(httpClient, 'request');
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );

    const requestContext = context();
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
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context(100)),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });
    expect(request).not.toHaveBeenCalled();
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'not_dispatched' },
    ]);
  });

  it('keeps a downstream success when recording its known outcome fails', async () => {
    const attempts = fakeDispatchAttempts();
    attempts.recorder.recordOutcome = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
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
      parseResponse: () => ({ overall_band: 7 }) as GradeResponse,
    };
    const dispatcher = new HttpOperationDispatcher(
      new DownstreamHttpClient('https://ai-writing.test', mockAgent),
      new FakeTokenIssuer(),
      [successfulAdapter],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).resolves.toMatchObject({ data: { overall_band: 7 } });
    expect(attempts.recorder.recordOutcome).toHaveBeenCalledWith(
      'attempt-test',
      'response_received',
    );
  });

  it('releases a reservation when local downstream configuration proves the request was not sent', async () => {
    const attempts = fakeDispatchAttempts();
    const budget = fakeSandboxBudget();
    const httpClient = new DownstreamHttpClient('', mockAgent);
    const dispatcher = new HttpOperationDispatcher(
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
        organizationLimit: 25,
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
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_THROTTLED', httpStatus: 503 });

    const logLine = readLogLine(loggerError);
    expect(JSON.parse(logLine)).toEqual({
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: 429,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: expect.any(Number),
      error_code: 'AI_SERVICE_THROTTLED',
      message: 'downstream status 429',
    });
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
  });

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
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      noOpDispatchAttemptRecord,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toBe(originalError);

    const logLine = readLogLine(loggerError);
    expect(JSON.parse(logLine)).toEqual({
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: null,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: expect.any(Number),
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
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      new FakeTokenIssuer(),
      [fakeGradeAdapter('/task-one')],
      attempts.recorder,
    );

    await expect(
      dispatcher.dispatch('writing.task1.grade', gradeInput, context()),
    ).rejects.toMatchObject({
      code: 'AI_SERVICE_UNAVAILABLE',
      httpStatus: 503,
    });

    const logLine = readLogLine(loggerError);
    expect(JSON.parse(logLine)).toEqual({
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/task-one',
      downstream_status: null,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: expect.any(Number),
      error_code: 'AI_SERVICE_UNAVAILABLE',
      message: 'downstream unreachable',
    });
    expect(logLine).not.toContain(transportMarker);
    expect(downstreamMs(logLine)).toBeGreaterThanOrEqual(0);
    expect(attempts.outcomes).toEqual([
      { attemptId: 'attempt-test', outcome: 'outcome_unknown' },
    ]);
  });

  it('records a received HTTP response when its body cannot be parsed', async () => {
    const attempts = fakeDispatchAttempts();
    mockAgent
      .get('https://ai-writing.test')
      .intercept({ method: 'POST', path: '/task-one' })
      .reply(200, 'not-json');
    const dispatcher = new HttpOperationDispatcher(
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
    const dispatcher = new HttpOperationDispatcher(
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
    expect(JSON.parse(logLine)).toEqual({
      event: 'downstream_failed',
      request_id: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      operation: 'writing.task1.grade',
      ai_service: 'ai-writing',
      private_endpoint: '/grade',
      downstream_status: 200,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: expect.any(Number),
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
      const dispatcher = new HttpOperationDispatcher(
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

      expect(JSON.parse(logLine)).toMatchObject({
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

      expect(JSON.parse(logLine).reason).toHaveLength(400);
    });

    it('omits the reason when the error carries none', async () => {
      const logLine = await dispatchViolation(
        new AppError({
          code: 'AI_SERVICE_CONTRACT_VIOLATION',
          message: 'AI service returned an unexpected response shape',
          retryable: false,
        }),
      );

      expect(JSON.parse(logLine)).not.toHaveProperty('reason');
    });
  });
});
