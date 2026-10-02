import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import { AppModule } from '../../../app.module';
import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import { PUBLIC_ROUTES } from '../../../catalog/public-routes';
import { AppError } from '../../../common/errors/app-error';
import { registerBodySizeGuard } from '../../../common/http/body-size.hook';
import { registerRequestLifecycle } from '../../../common/http/request-lifecycle.hook';
import { registerRequestTracing } from '../../../common/http/request-tracing.hook';
import { createRequestLogging } from '../../../common/observability/request-logger';
import { generateRequestId } from '../../../common/request-context/request-id';
import type { DispatchResult } from '../../gateway/application/operation-dispatcher.port';
import { OPERATION_DISPATCHER } from '../../gateway/application/operation-dispatcher.port';
import { QUOTA_COUNTER } from '../../gateway/application/quota-counter.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '../../idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '../../idempotency/application/idempotency-service.port';
import type {
  UsageAggregate,
  UsageAggregateQuery,
} from '../application/usage-repository.port';
import { USAGE_REPOSITORY } from '../application/usage-repository.port';
import { registerRequestCompletionLog } from './request-completion-log.hook';

const GRADE_OPERATION = OPERATION_CATALOG['writing.task1.grade'];
const GRADE_URL = GRADE_OPERATION.path;
const GRADE_BODY_LIMIT = GRADE_OPERATION.maxBodyBytes;
const RENAMABLE_ORGANIZATION = PUBLIC_ROUTES['organizations.rename'].path;

const VALID_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay.',
  image_url: 'https://example.com/chart.png',
};

const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Stands in for container stdout, so assertions read the real log lines. */
class CapturedLog {
  private readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  reset(): void {
    this.lines.length = 0;
  }

  all(): Record<string, unknown>[] {
    return this.lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
  }

  completions(): Record<string, unknown>[] {
    return this.all().filter((line) => line['event'] === 'request_completed');
  }

  /**
   * The single completion event a response produced. Counting lines is how an
   * operator counts requests, so a test that reads one is also asserting there
   * was exactly one.
   */
  only(): Record<string, unknown> {
    const completions = this.completions();
    if (completions.length !== 1) {
      throw new Error(
        `expected exactly one request_completed line, wrote ${completions.length}`,
      );
    }

    return completions[0] as Record<string, unknown>;
  }
}

const GRADED_RESPONSE: DispatchResult<unknown> = {
  operation: 'writing.task1.grade',
  data: { accepted: true },
  downstreamMs: 7,
};

/** A dispatcher whose next answer the test chooses, so one seam covers every outcome. */
class ScriptedDispatcher {
  private behaviour: () => Promise<DispatchResult<unknown>> = () =>
    Promise.resolve(GRADED_RESPONSE);

  failWith(error: unknown): void {
    this.behaviour = () => Promise.reject(error);
  }

  succeed(): void {
    this.behaviour = () => Promise.resolve(GRADED_RESPONSE);
  }

  dispatch = (): Promise<DispatchResult<unknown>> => this.behaviour();
}

/** A metering repository that can be armed to reject, so the real MeteringService runs. */
class ScriptedUsageRepository {
  private failing = false;

  failInserts(): void {
    this.failing = true;
  }

  succeed(): void {
    this.failing = false;
  }

  insert(): Promise<void> {
    return this.failing
      ? Promise.reject(new Error('metering store unavailable'))
      : Promise.resolve();
  }

  aggregate(_query: UsageAggregateQuery): Promise<UsageAggregate> {
    return Promise.resolve({
      billableRequestCount: 0,
      billableTokenCount: 0,
      missingUsageCount: 0,
    });
  }
}

const idempotency = {
  async execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    _decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>> {
    return {
      result: await work({
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      }),
      replay: false,
    };
  },
} satisfies IdempotencyServicePort;

describe('request completion log over the HTTP boundary', () => {
  let app: NestFastifyApplication;
  let log: CapturedLog;
  let sdk: NodeSDK;
  const exporter = new InMemorySpanExporter();
  const dispatcher = new ScriptedDispatcher();
  const usageRepository = new ScriptedUsageRepository();
  const originalAllowBypass = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    log = new CapturedLog();

    // A real SDK, so the span the request runs inside — and therefore the
    // trace id on its completion line — is a genuine one.
    sdk = new NodeSDK({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
    });
    sdk.start();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(USAGE_REPOSITORY)
      .useValue(usageRepository)
      // Keeps the real MeteringService — which owns the failure logger this
      // test observes — without any provider reaching for Redis.
      .overrideProvider(QUOTA_COUNTER)
      .useValue({
        read: () => Promise.resolve(0),
        increment: () => Promise.resolve(),
      })
      .overrideProvider(OPERATION_DISPATCHER)
      .useValue(dispatcher)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotency)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        ...createRequestLogging(log),
        genReqId: () => generateRequestId(),
      }),
    );

    // The hooks the application bootstrap registers, in the order it registers
    // them, so the test proves the shape that actually ships.
    const fastify = app.getHttpAdapter().getInstance();
    registerRequestTracing(fastify, trace.getTracer('aihub.request.test'));
    registerBodySizeGuard(fastify);
    registerRequestLifecycle(fastify);
    registerRequestCompletionLog(fastify);

    await app.init();
    await fastify.ready();
  });

  afterAll(async () => {
    await app.close();
    await sdk.shutdown();
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalAllowBypass;
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    dispatcher.succeed();
    usageRepository.succeed();
    log.reset();
    exporter.reset();
  });

  it('writes one event describing an authenticated graded request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-success' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(log.only()).toEqual({
      level: 'info',
      time: expect.any(Number),
      event: 'request_completed',
      request_id: expect.stringMatching(REQUEST_ID_PATTERN),
      trace_id: expect.stringMatching(TRACE_ID_PATTERN),
      method: 'POST',
      route: GRADE_URL,
      http_status: 200,
      total_ms: expect.any(Number),
      outcome: 'success',
      org_id: 'local-development',
      operation: 'writing.task1.grade',
      environment: 'development',
    });
  });

  it('writes one event with the public error code for a validation failure', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-invalid' },
      payload: { question: 'missing the required grading fields' },
    });

    expect(response.statusCode).toBe(400);
    expect(log.only()).toEqual(
      expect.objectContaining({
        http_status: 400,
        outcome: 'client_error',
        error_code: 'INVALID_REQUEST',
      }),
    );
  });

  it('writes one event naming the specific downstream failure', async () => {
    dispatcher.failWith(
      new AppError({
        code: 'AI_SERVICE_TIMEOUT',
        message: 'AI service request timed out',
        retryable: true,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-downstream' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(504);
    expect(log.only()).toEqual(
      expect.objectContaining({
        http_status: 504,
        outcome: 'downstream_error',
        error_code: 'AI_SERVICE_TIMEOUT',
      }),
    );
  });

  it('writes one internal-error event for an unexpected failure', async () => {
    dispatcher.failWith(new Error('something nobody classified'));

    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-unexpected' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(500);
    expect(log.only()).toEqual(
      expect.objectContaining({
        http_status: 500,
        outcome: 'internal_error',
        error_code: 'INTERNAL_ERROR',
      }),
    );
  });

  it('still writes one event for a body rejected before the application runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'content-type': 'application/json',
        'content-length': String(GRADE_BODY_LIMIT + 1),
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(413);
    expect(log.only()).toEqual(
      expect.objectContaining({
        http_status: 413,
        outcome: 'client_error',
        error_code: 'PAYLOAD_TOO_LARGE',
      }),
    );
  });

  it('logs an unmatched path under a fixed route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/scanner/probe',
    });

    expect(response.statusCode).toBe(404);
    expect(log.only()).toEqual(
      expect.objectContaining({
        method: 'GET',
        route: 'unmatched',
        http_status: 404,
        outcome: 'client_error',
        error_code: 'NOT_FOUND',
      }),
    );
  });

  it('omits the organization keys entirely for a request that never authenticated', async () => {
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'false';

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(401);
    } finally {
      process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    }

    const event = log.only();
    expect(event['outcome']).toBe('client_error');
    expect(Object.keys(event)).not.toContain('org_id');
    expect(Object.keys(event)).not.toContain('operation');
    expect(Object.keys(event)).not.toContain('environment');
  });

  it('writes no event for a health probe', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(log.completions()).toHaveLength(0);
  });

  it('ignores a client-supplied request id and logs the generated one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'idempotency-key': 'completion-forged-id',
        'request-id': 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(log.only()['request_id']).not.toBe('req_01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('names the trace the request ran inside so a line leads to its spans', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-trace' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(log.only()['trace_id']).toBe(
      exporter.getFinishedSpans()[0]?.spanContext().traceId,
    );
  });

  it('keeps a subsystem failure beside the one completion event', async () => {
    const subsystemLines: unknown[] = [];
    const operationalLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        subsystemLines.push(message);
      });

    try {
      usageRepository.failInserts();

      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        headers: { 'idempotency-key': 'completion-subsystem' },
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(200);
      expect(log.completions()).toHaveLength(1);
      expect(JSON.stringify(subsystemLines)).toContain('metering_write_failed');
    } finally {
      operationalLog.mockRestore();
    }
  });

  it('keeps credentials, content, and exception detail out of every line', async () => {
    dispatcher.failWith(
      new Error('private-marker', { cause: new Error('private-marker') }),
    );

    // Every channel the spec names, each carrying the same marker: API key,
    // authorization, cookie, signed assertion, query value, path parameter,
    // essay body, and an exception whose message and cause both hold it.
    await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        authorization: 'Bearer private-marker',
        cookie: 'refresh=private-marker',
        'idempotency-key': 'completion-markers',
        'x-api-key': 'private-marker',
        'x-user-identity': 'private-marker',
      },
      query: { marker: 'private-marker' },
      payload: { ...VALID_BODY, essay: 'private-marker' },
    });

    await app.inject({
      method: 'PATCH',
      url: RENAMABLE_ORGANIZATION.replace(':organizationId', 'private-marker'),
      headers: { authorization: 'Bearer private-marker' },
      payload: { name: 'private-marker' },
    });

    const lines = log.all();
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('private-marker');
    expect(JSON.stringify(lines)).not.toContain('stack');
    expect(JSON.stringify(lines)).not.toContain('cause');
  });

  it('names a parameterised route by its template, never by its values', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: RENAMABLE_ORGANIZATION.replace(
        ':organizationId',
        'org_private-marker',
      ),
      headers: { authorization: 'Bearer private-marker' },
      payload: { name: 'private-marker' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(log.only()['route']).toBe(RENAMABLE_ORGANIZATION);
  });
});
