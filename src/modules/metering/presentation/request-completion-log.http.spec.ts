import { request as httpRequest } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

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

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError } from '@/common/errors/app-error';
import { METRICS_ROUTE_PATH } from '@/common/observability/metrics';
import { registerMetricsRoute } from '@/common/observability/metrics.route';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { OPERATION_DISPATCHER } from '@/modules/gateway/application/operation-dispatcher.port';
import { QUOTA_COUNTER } from '@/modules/gateway/application/quota-counter.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '@/modules/idempotency/application/idempotency-service.port';
import type {
  UsageAggregate,
  UsageAggregateQuery,
  UsageRecord,
} from '@/modules/metering/application/usage-repository.port';
import { USAGE_REPOSITORY } from '@/modules/metering/application/usage-repository.port';
import { registerRequestHooks } from '@/register-request-hooks';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    return this.lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error('expected every log line to be a JSON object');
      }

      return parsed;
    });
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
    const [completion] = completions;
    if (completions.length !== 1 || completion === undefined) {
      throw new Error(
        `expected exactly one request_completed line, wrote ${completions.length}`,
      );
    }

    return completion;
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

  /** Holds the next dispatch until `release` is called, so a client can leave first. */
  stall(): { readonly started: Promise<void>; readonly release: () => void } {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.behaviour = async () => {
      started();
      await gate;
      return GRADED_RESPONSE;
    };

    return { started: startedPromise, release };
  }

  dispatch = (): Promise<DispatchResult<unknown>> => this.behaviour();
}

/** A metering repository that can be armed to reject, so the real MeteringService runs. */
class ScriptedUsageRepository {
  readonly records: UsageRecord[] = [];
  private failing = false;

  failInserts(): void {
    this.failing = true;
  }

  succeed(): void {
    this.failing = false;
  }

  insert(record: UsageRecord): Promise<void> {
    if (this.failing) {
      return Promise.reject(new Error('metering store unavailable'));
    }

    this.records.push(record);
    return Promise.resolve();
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

/** Total observations of a counter family, summed across its label sets. */
async function metricValue(
  application: NestFastifyApplication,
  name: string,
): Promise<number> {
  const body = (
    await application.inject({ method: 'GET', url: METRICS_ROUTE_PATH })
  ).body;
  const lines = String(body)
    .split('\n')
    .filter((line) => line.startsWith(`${name}{`));

  return lines.reduce((total, line) => {
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

describe('request completion log over the HTTP boundary', () => {
  let app: NestFastifyApplication;
  let log: CapturedLog;
  let sdk: NodeSDK;
  const exporter = new InMemorySpanExporter();
  const dispatcher = new ScriptedDispatcher();
  const usageRepository = new ScriptedUsageRepository();
  const originalAllowBypass = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;
  const originalNodeEnv = process.env.NODE_ENV;

  function restoreEnvironment(
    name: string,
    original: string | undefined,
  ): void {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }

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

    // The same hooks, in the same order, as the application bootstrap.
    const fastify = app.getHttpAdapter().getInstance();
    registerRequestHooks(fastify, trace.getTracer('aihub.request.test'));
    registerMetricsRoute(fastify);

    await app.init();
    await fastify.ready();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await sdk.shutdown();
    restoreEnvironment('AIHUB_ALLOW_UNAUTHENTICATED_DEV', originalAllowBypass);
    restoreEnvironment('NODE_ENV', originalNodeEnv);
  });

  beforeEach(() => {
    dispatcher.succeed();
    usageRepository.succeed();
    usageRepository.records.length = 0;
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
    // Fastify's own per-request lines are off, so the completion event is the
    // only line the request writes.
    expect(log.all()).toHaveLength(1);
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

  it('reports the same total time the Metering record was written with', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-total' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(usageRepository.records).toHaveLength(1);
    expect(log.only()['total_ms']).toBe(usageRepository.records[0]?.totalMs);
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

  it('counts a graded request in the scrape endpoint', async () => {
    await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'content-type': 'application/json' },
      payload: VALID_BODY,
    });

    const payload = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    // The catalog's own identifier is the only operation label value, never
    // the URL the caller asked for.
    expect(payload).toContain(
      'aihub_requests_total{operation="writing.task1.grade"',
    );
    expect(payload).toContain('aihub_downstream_duration_seconds_count');
    expect(payload).toContain('aihub_request_duration_seconds_count');
  });

  it('counts no scrape as a customer request', async () => {
    const before = await metricValue(app, 'aihub_requests_total');

    await app.inject({ method: 'GET', url: '/metrics' });

    expect(await metricValue(app, 'aihub_requests_total')).toBe(before);
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

  it('writes no event for a request the client abandoned before a response', async () => {
    const stalled = dispatcher.stall();
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected the test server to listen on a TCP port');
    }
    const { port }: AddressInfo = address;
    const body = JSON.stringify(VALID_BODY);

    // The server must have seen the connection close before the handler is
    // released; otherwise it can still write the reply, and the event is then
    // legitimate.
    const serverSawClose = new Promise<void>((resolve) => {
      app
        .getHttpServer()
        .once('connection', (socket: Socket) =>
          socket.once('close', () => resolve()),
        );
    });
    const clientLeft = new Promise<void>((resolve) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: GRADE_URL,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'idempotency-key': 'completion-abandoned',
          },
        },
        () => undefined,
      );
      outgoing.on('error', () => resolve());
      outgoing.on('close', () => resolve());
      outgoing.end(body);
      // The dispatcher is reached only once the request is past every hook, so
      // the client leaves while the server is still working on it.
      void stalled.started.then(() => outgoing.destroy());
    });

    await clientLeft;
    await serverSawClose;
    stalled.release();
    // The server's late reply has nowhere to go; give it time to finish.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(log.completions()).toHaveLength(0);
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
