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
} from '@opentelemetry/sdk-trace';

import { AppModule } from '@/app.module';
import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { AppError } from '@/common/errors/app-error';
import { METRICS_ROUTE_PATH, getMetrics } from '@/common/observability/metrics';
import { registerMetricsRoute } from '@/common/observability/metrics.route';
import { createRequestLogging } from '@/common/observability/request-logger';
import { generateRequestId } from '@/common/request-context/request-id';
import { appConfig } from '@/config/runtime-configuration';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { OPERATION_DISPATCHER } from '@/modules/gateway/application/operation-dispatcher.port';
import { QUOTA_COUNTER } from '@/modules/gateway/application/quota-counter.port';
import { GradedAdmissionGuard } from '@/modules/gateway/presentation/graded-admission.guard';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '@/modules/idempotency/application/idempotency-service.port';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { ApiKeyGuard } from '@/modules/identity/api-keys/presentation/api-key.guard';
import type { UsageRecord } from '@/modules/metering/application/usage-repository.port';
import { USAGE_REPOSITORY } from '@/modules/metering/application/usage-repository.port';
import { registerRequestHooks } from '@/register-request-hooks';
import { getOwnPrototypeMethod } from '../../../../test/support/own-prototype-method';

const GRADE_OPERATION = OPERATION_CATALOG['writing.task1.grade'];
const GRADE_URL = GRADE_OPERATION.path;
const GRADE_BODY_LIMIT = GRADE_OPERATION.maxBodyBytes;
const RENAMABLE_ORGANIZATION = PUBLIC_ROUTES['organizations.rename'].path;
const API_KEY_ID = 'ak_request_completion_test';
const API_KEY_VALUE = 'request-completion-secret-marker';

const VALID_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay.',
  image_url: 'https://example.com/chart.png',
};

const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

function matchesPattern(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value);
}

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

const testApiKeyAuthenticator: ApiKeyAuthenticatorPort = {
  authenticate: ({ environment, value }) => {
    if (value.length === 0) {
      return Promise.reject(
        new AppError({
          code: 'UNAUTHORIZED',
          message: 'API key is invalid',
          retryable: false,
        }),
      );
    }

    return Promise.resolve({
      organizationId: 'local-development',
      apiKeyId: API_KEY_ID,
      environment,
      scopes: [GRADE_OPERATION.requiredScope],
      rateLimitRpm: 60,
      maxConcurrent: 1,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
      allowedEnvironments: ['production'],
    });
  },
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
  delayMs = 0;

  failInserts(): void {
    this.failing = true;
  }

  succeed(): void {
    this.failing = false;
  }

  async insert(record: UsageRecord): Promise<void> {
    if (this.failing) {
      throw new Error('metering store unavailable');
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.records.push(record);
  }
}

let idempotencyDelayMs = 0;
let retryBudgetUnavailable = false;
let permitReleaseDelayMs = 0;
let permitReleaseUnavailable = false;

const idempotency = {
  async execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    _decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>> {
    if (idempotencyDelayMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, idempotencyDelayMs),
      );
    }
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
  _application: NestFastifyApplication,
  name: string,
  labels?: Record<string, string>,
): Promise<number> {
  const body = await getMetrics();
  const selector =
    labels === undefined
      ? `${name}{`
      : `${name}{${Object.entries(labels)
          .map(([key, value]) => `${key}="${value}"`)
          .join(',')}} `;
  const lines = String(body)
    .split('\n')
    .filter((line) => line.startsWith(selector));

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
  const runtimeConfiguration = {
    ...appConfig(),
    NODE_ENV: 'test',
    AIHUB_ALLOW_UNAUTHENTICATED_DEV: true,
  };

  beforeAll(async () => {
    log = new CapturedLog();

    // A real SDK, so the span the request runs inside — and therefore the
    // trace id on its completion line — is a genuine one.
    sdk = new NodeSDK({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
      instrumentations: [],
    });
    sdk.start();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(appConfig.KEY)
      .useValue(runtimeConfiguration)
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
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(testApiKeyAuthenticator)
      .overrideProvider(GRADED_ADMISSION)
      .useValue({
        consume: async () => {
          if (retryBudgetUnavailable) {
            throw new AppError({
              code: 'REDIS_UNAVAILABLE',
              message: 'Grading controls are temporarily unavailable',
              retryable: true,
              retryAfterMs: 1_000,
            });
          }
          return { stage: 'admitted' };
        },
      })
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue({
        acquire: async () => ({
          allowed: true,
          lease: {
            release: async () => {
              if (permitReleaseDelayMs > 0) {
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, permitReleaseDelayMs),
                );
              }
              if (permitReleaseUnavailable) {
                throw new AppError({
                  code: 'REDIS_UNAVAILABLE',
                  message: 'Grading controls are temporarily unavailable',
                  retryable: true,
                  retryAfterMs: 1_000,
                });
              }
            },
          },
        }),
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        ...createRequestLogging(log),
        trustProxy: '127.0.0.1',
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
  });

  beforeEach(() => {
    dispatcher.succeed();
    usageRepository.succeed();
    idempotencyDelayMs = 0;
    retryBudgetUnavailable = false;
    permitReleaseDelayMs = 0;
    permitReleaseUnavailable = false;
    usageRepository.delayMs = 0;
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
    expect(response.headers['x-request-id']).toBe(log.only()['request_id']);
    // Fastify's own per-request lines are off, so the completion event is the
    // only line the request writes.
    expect(log.all()).toHaveLength(1);
    const {
      time,
      request_id,
      trace_id,
      total_ms,
      admission_ms,
      completion_ms,
      ...event
    } = log.only();
    expect(event).toEqual({
      level: 'info',
      event: 'request_completed',
      client_ip: '127.0.0.1',
      client_ip_source: 'direct_peer',
      method: 'POST',
      route: GRADE_URL,
      http_status: 200,
      outcome: 'success',
      org_id: 'local-development',
      operation: 'writing.task1.grade',
      environment: 'development',
      identity_mode: 'declared_id',
      retry_budget: 'keyed_writing',
    });
    expect(typeof time).toBe('number');
    expect(matchesPattern(request_id, REQUEST_ID_PATTERN)).toBe(true);
    expect(matchesPattern(trace_id, TRACE_ID_PATTERN)).toBe(true);
    expect(typeof total_ms).toBe('number');
    expect(typeof admission_ms).toBe('number');
    expect(typeof completion_ms).toBe('number');
  });

  it('records the authenticated API key id and address resolved through the proxy', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'idempotency-key': 'completion-api-key',
        'x-api-key': API_KEY_VALUE,
        'x-forwarded-for': '203.0.113.42',
      },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(log.only()['request_id']);
    const {
      time,
      request_id,
      trace_id,
      total_ms,
      admission_ms,
      completion_ms,
      ...event
    } = log.only();
    expect(event).toEqual({
      level: 'info',
      event: 'request_completed',
      client_ip: '203.0.113.42',
      client_ip_source: 'nginx',
      method: 'POST',
      route: GRADE_URL,
      http_status: 200,
      outcome: 'success',
      api_key_id: API_KEY_ID,
      org_id: 'local-development',
      operation: 'writing.task1.grade',
      environment: 'development',
      identity_mode: 'declared_id',
      retry_budget: 'keyed_writing',
    });
    expect(typeof time).toBe('number');
    expect(matchesPattern(request_id, REQUEST_ID_PATTERN)).toBe(true);
    expect(matchesPattern(trace_id, TRACE_ID_PATTERN)).toBe(true);
    expect(typeof total_ms).toBe('number');
    expect(typeof admission_ms).toBe('number');
    expect(typeof completion_ms).toBe('number');
    expect(JSON.stringify(log.all())).not.toContain(API_KEY_VALUE);
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

  it('includes a slow real guard in response, log, and histograms', async () => {
    const delayMs = 75;
    const original = getOwnPrototypeMethod(
      GradedAdmissionGuard.prototype,
      'canActivate',
    );
    const totalBefore = await metricValue(
      app,
      'aihub_request_duration_seconds_sum',
    );
    const admissionBefore = await metricValue(
      app,
      'aihub_admission_duration_seconds_sum',
    );
    const delayGuard = jest
      .spyOn(GradedAdmissionGuard.prototype, 'canActivate')
      .mockImplementation(async function (this: GradedAdmissionGuard, context) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return original.call(this, context);
      });

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        headers: { 'idempotency-key': 'completion-slow-guard' },
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(200);
      const totalMs = (
        response.json() as { meta: { timing: { total_ms: number } } }
      ).meta.timing.total_ms;
      const event = log.only();
      expect(totalMs).toBeGreaterThanOrEqual(delayMs - 10);
      expect(event['total_ms']).toBe(totalMs);
      expect(event['admission_ms']).toBeGreaterThanOrEqual(delayMs - 10);
      expect(
        (await metricValue(app, 'aihub_request_duration_seconds_sum')) -
          totalBefore,
      ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
      expect(
        (await metricValue(app, 'aihub_admission_duration_seconds_sum')) -
          admissionBefore,
      ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
    } finally {
      delayGuard.mockRestore();
    }
  });

  it('measures completion through usage persistence and permit release without changing total_ms', async () => {
    usageRepository.delayMs = 40;
    permitReleaseDelayMs = 40;
    const completionBefore = await metricValue(
      app,
      'aihub_graded_completion_duration_seconds_sum',
    );

    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-settled' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const event = log.only();
    expect(event['completion_ms']).toBeGreaterThanOrEqual(70);
    expect(event['total_ms']).toBeLessThan(event['completion_ms'] as number);
    expect(
      (await metricValue(app, 'aihub_graded_completion_duration_seconds_sum')) -
        completionBefore,
    ).toBeGreaterThanOrEqual(0.07);
    const metrics = String(
      (await app.inject({ method: 'GET', url: METRICS_ROUTE_PATH })).body,
    );
    expect(metrics).toMatch(
      /aihub_graded_completion_duration_seconds_count\{[^}]*operation="writing\.task1\.grade"[^}]*identity_mode="declared_id"[^}]*retry_budget="keyed_writing"[^}]*\} [1-9]/,
    );
  });

  it('preserves successful grading and metering when permit release fails', async () => {
    permitReleaseUnavailable = true;
    const completionCountBefore = await metricValue(
      app,
      'aihub_graded_completion_duration_seconds_count',
    );
    const dispatch = jest.spyOn(dispatcher, 'dispatch');

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        headers: { 'idempotency-key': 'completion-release-outage' },
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(usageRepository.records).toHaveLength(1);
      expect(usageRepository.records[0]).toMatchObject({
        outcome: 'success',
        httpStatus: 200,
        billableRequests: 1,
        billingBasis: 'response',
      });
      expect(log.only()).toEqual(
        expect.objectContaining({ http_status: 200, outcome: 'success' }),
      );
      expect(log.only()['completion_ms']).toBeUndefined();
      expect(
        await metricValue(
          app,
          'aihub_graded_completion_duration_seconds_count',
        ),
      ).toBe(completionCountBefore);
    } finally {
      dispatch.mockRestore();
    }
  });

  it('preserves a handler error and its Metering outcome when permit release fails', async () => {
    dispatcher.failWith(
      new AppError({
        code: 'AI_SERVICE_TIMEOUT',
        message: 'AI service request timed out',
        retryable: true,
      }),
    );
    permitReleaseUnavailable = true;
    const dispatch = jest.spyOn(dispatcher, 'dispatch');

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        headers: { 'idempotency-key': 'completion-release-error' },
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({
        error: { code: 'AI_SERVICE_TIMEOUT' },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(usageRepository.records).toHaveLength(1);
      expect(usageRepository.records[0]).toMatchObject({
        outcome: 'downstream_error',
        httpStatus: 504,
        errorCode: 'AI_SERVICE_TIMEOUT',
        billableRequests: 0,
      });
      expect(log.only()).toEqual(
        expect.objectContaining({
          http_status: 504,
          outcome: 'downstream_error',
          error_code: 'AI_SERVICE_TIMEOUT',
        }),
      );
    } finally {
      dispatch.mockRestore();
    }
  });

  it('starts admission timing after Writing idempotency work, at dispatch', async () => {
    const delayMs = 75;
    idempotencyDelayMs = delayMs;
    const admissionBefore = await metricValue(
      app,
      'aihub_admission_duration_seconds_sum',
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        headers: { 'idempotency-key': 'completion-slow-idempotency' },
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(200);
      const event = log.only();
      expect(event['total_ms']).toBeGreaterThanOrEqual(delayMs - 10);
      expect(event['admission_ms']).toBeGreaterThanOrEqual(delayMs - 10);
      expect(
        (await metricValue(app, 'aihub_admission_duration_seconds_sum')) -
          admissionBefore,
      ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
    } finally {
      idempotencyDelayMs = 0;
    }
  });

  it('records guard refusal time before dispatch in the log and histograms', async () => {
    const delayMs = 75;
    const totalBefore = await metricValue(
      app,
      'aihub_request_duration_seconds_sum',
    );
    const admissionBefore = await metricValue(
      app,
      'aihub_admission_duration_seconds_sum',
    );
    const refusalGuard = jest
      .spyOn(GradedAdmissionGuard.prototype, 'canActivate')
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        throw new AppError({
          code: 'QUOTA_EXCEEDED',
          message: 'Monthly request quota exceeded',
          retryable: true,
        });
      });

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(429);
      const event = log.only();
      expect(event['total_ms']).toBeGreaterThanOrEqual(delayMs - 10);
      expect(event['admission_ms']).toBeGreaterThanOrEqual(delayMs - 10);
      expect(
        (await metricValue(app, 'aihub_request_duration_seconds_sum')) -
          totalBefore,
      ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
      expect(
        (await metricValue(app, 'aihub_admission_duration_seconds_sum')) -
          admissionBefore,
      ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
    } finally {
      refusalGuard.mockRestore();
    }
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

  it('counts a retry-budget outage by operation and public response outcome', async () => {
    const metricsBefore = await metricValue(app, 'aihub_requests_total');
    retryBudgetUnavailable = true;

    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: { 'idempotency-key': 'completion-budget-outage' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'REDIS_UNAVAILABLE',
        retryable: true,
        retry_after_ms: 1_000,
      },
    });
    expect(log.only()).toEqual(
      expect.objectContaining({
        operation: 'writing.task1.grade',
        http_status: 503,
        outcome: 'internal_error',
        error_code: 'REDIS_UNAVAILABLE',
      }),
    );
    expect(await metricValue(app, 'aihub_requests_total')).toBe(
      metricsBefore + 1,
    );
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain(
      'aihub_requests_total{operation="writing.task1.grade",status="503",outcome="internal_error"}',
    );
  });

  it('still writes one event for a body rejected before the application runs', async () => {
    const totalCountBefore = await metricValue(
      app,
      'aihub_request_duration_seconds_count',
    );
    const admissionCountBefore = await metricValue(
      app,
      'aihub_admission_duration_seconds_count',
    );
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
    expect(
      (await metricValue(app, 'aihub_request_duration_seconds_count')) -
        totalCountBefore,
    ).toBe(1);
    expect(
      (await metricValue(app, 'aihub_admission_duration_seconds_count')) -
        admissionCountBefore,
    ).toBe(1);

    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain(
      'aihub_request_duration_seconds_count{operation="writing.task1.grade"}',
    );
  });

  it('logs an unmatched path under a fixed route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/scanner/probe',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe(log.only()['request_id']);
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

  it('counts paths without catalog operations under one fixed operation label', async () => {
    const paths = [
      '/scanner/probe-alpha?target=alpha',
      '/arbitrary/path-984?target=beta',
    ];
    const labels = {
      operation: 'unmatched',
      status: '404',
      outcome: 'client_error',
    };
    const totalBefore = await metricValue(app, 'aihub_requests_total');
    const unmatchedBefore = await metricValue(
      app,
      'aihub_requests_total',
      labels,
    );

    for (const path of paths) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(404);
    }

    expect(await metricValue(app, 'aihub_requests_total')).toBe(
      totalBefore + paths.length,
    );
    const unmatchedAfter = await metricValue(
      app,
      'aihub_requests_total',
      labels,
    );
    expect(unmatchedAfter).toBe(unmatchedBefore + paths.length);

    const payload = String(
      (await app.inject({ method: 'GET', url: METRICS_ROUTE_PATH })).body,
    );
    expect(payload).toContain(
      `aihub_requests_total{operation="unmatched",status="404",outcome="client_error"} ${unmatchedAfter}`,
    );
    for (const path of paths) {
      expect(payload).not.toContain(path);
    }
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

  it('counts metrics scrapes without logging completion events', async () => {
    const before = await metricValue(app, 'aihub_requests_total');
    const unmatchedBefore = await metricValue(app, 'aihub_requests_total', {
      operation: 'unmatched',
      status: '200',
      outcome: 'success',
    });

    const response = await app.inject({
      method: 'GET',
      url: METRICS_ROUTE_PATH,
    });

    expect(response.statusCode).toBe(200);
    expect(await metricValue(app, 'aihub_requests_total')).toBe(before + 1);
    expect(
      await metricValue(app, 'aihub_requests_total', {
        operation: 'unmatched',
        status: '200',
        outcome: 'success',
      }),
    ).toBe(unmatchedBefore + 1);
    expect(log.completions()).toHaveLength(0);
  });

  it('records a delayed API-key refusal without creating Metering evidence', async () => {
    const delayMs = 75;
    const slowLogWriteMs = 20;
    const apiKeyRefusalLabels = {
      operation: 'writing.task1.grade',
      status: '401',
      outcome: 'client_error',
    };
    const requestsBefore = await metricValue(app, 'aihub_requests_total');
    const apiKeyRefusalsBefore = await metricValue(
      app,
      'aihub_requests_total',
      apiKeyRefusalLabels,
    );
    const totalBefore = await metricValue(
      app,
      'aihub_request_duration_seconds_sum',
    );
    const admissionBefore = await metricValue(
      app,
      'aihub_admission_duration_seconds_sum',
    );
    const original = getOwnPrototypeMethod(
      ApiKeyGuard.prototype,
      'canActivate',
    );
    const delayGuard = jest
      .spyOn(ApiKeyGuard.prototype, 'canActivate')
      .mockImplementation(async function (this: ApiKeyGuard, context) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return original.call(this, context);
      });
    const originalWrite = log.write.bind(log);
    const slowLogWrite = jest.spyOn(log, 'write').mockImplementation((line) => {
      const startedAt = performance.now();
      while (performance.now() - startedAt < slowLogWriteMs) {
        // Simulate synchronous log serialization/backpressure before metrics.
      }
      originalWrite(line);
    });
    runtimeConfiguration.AIHUB_ALLOW_UNAUTHENTICATED_DEV = false;

    try {
      const response = await app.inject({
        method: 'POST',
        url: GRADE_URL,
        payload: VALID_BODY,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['x-request-id']).toBe(log.only()['request_id']);
    } finally {
      runtimeConfiguration.AIHUB_ALLOW_UNAUTHENTICATED_DEV = true;
      delayGuard.mockRestore();
      slowLogWrite.mockRestore();
    }

    const event = log.only();
    expect(event['total_ms']).toBeGreaterThanOrEqual(delayMs - 10);
    expect(event['admission_ms']).toBeGreaterThanOrEqual(delayMs - 10);
    expect(event['outcome']).toBe('client_error');
    expect(event['client_ip_source']).toBe('direct_peer');
    expect(Object.keys(event)).not.toContain('api_key_id');
    expect(Object.keys(event)).not.toContain('org_id');
    expect(Object.keys(event)).not.toContain('operation');
    expect(Object.keys(event)).not.toContain('environment');
    expect(await metricValue(app, 'aihub_requests_total')).toBe(
      requestsBefore + 1,
    );
    expect(
      await metricValue(app, 'aihub_requests_total', apiKeyRefusalLabels),
    ).toBe(apiKeyRefusalsBefore + 1);
    expect(
      (await metricValue(app, 'aihub_request_duration_seconds_sum')) -
        totalBefore,
    ).toBeCloseTo((event['total_ms'] as number) / 1000, 8);
    expect(
      (await metricValue(app, 'aihub_admission_duration_seconds_sum')) -
        admissionBefore,
    ).toBeGreaterThanOrEqual((delayMs - 10) / 1000);
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

  it('counts a health response without logging it', async () => {
    const before = await metricValue(app, 'aihub_requests_total');
    const unmatchedBefore = await metricValue(app, 'aihub_requests_total', {
      operation: 'unmatched',
      status: '200',
      outcome: 'success',
    });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(await metricValue(app, 'aihub_requests_total')).toBe(before + 1);
    expect(
      await metricValue(app, 'aihub_requests_total', {
        operation: 'unmatched',
        status: '200',
        outcome: 'success',
      }),
    ).toBe(unmatchedBefore + 1);
    expect(log.completions()).toHaveLength(0);
  });

  it('ignores a client-supplied request id and logs the generated one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GRADE_URL,
      headers: {
        'idempotency-key': 'completion-forged-id',
        'request-id': 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        'x-request-id': 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(log.only()['request_id']).not.toBe('req_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(response.headers['x-request-id']).toBe(log.only()['request_id']);
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
