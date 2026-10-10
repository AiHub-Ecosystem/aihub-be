import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { AppModule } from '@/app.module';
import { GracefulFastifyAdapter } from '@/common/http/graceful-fastify-adapter';
import { registerMetricsRoute } from '@/common/observability/metrics.route';
import { generateRequestId } from '@/common/request-context/request-id';
import { appConfig } from '@/config/runtime-configuration';
import type { ConcurrencyLimiterPort } from '@/modules/gateway/application/concurrency-limiter.port';
import { CONCURRENCY_LIMITER } from '@/modules/gateway/application/concurrency-limiter.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from '@/modules/gateway/application/operation-dispatcher.port';
import { OPERATION_DISPATCHER } from '@/modules/gateway/application/operation-dispatcher.port';
import type { QuotaCounterPort } from '@/modules/gateway/application/quota-counter.port';
import { QUOTA_COUNTER } from '@/modules/gateway/application/quota-counter.port';
import type {
  CompleteIdempotencyInput,
  IdempotencyAttemptInput,
  IdempotencyRepositoryPort,
  IdempotencyReservation,
  ReserveIdempotencyInput,
} from '@/modules/idempotency/application/idempotency-repository.port';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
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
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';
import { USAGE_REPOSITORY } from '@/modules/metering/application/usage-repository.port';
import { registerRequestHooks } from '@/register-request-hooks';

const GRADE_PATH = '/v1/ielts/writing/task1/grade';
const GRADE_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'A clear essay.',
  image_url: 'https://example.com/chart.png',
};

class InMemoryIdempotencyRepository implements IdempotencyRepositoryPort {
  readonly completed: CompleteIdempotencyInput[] = [];
  private readonly pending = new Set<string>();

  async reserve(
    input: ReserveIdempotencyInput,
  ): Promise<IdempotencyReservation> {
    if (this.pending.has(input.idempotencyKey)) {
      return { kind: 'conflict', reason: 'pending' };
    }
    this.pending.add(input.idempotencyKey);
    return { kind: 'claimed', requestId: input.requestId };
  }

  async complete(input: CompleteIdempotencyInput): Promise<void> {
    this.pending.delete(input.idempotencyKey);
    this.completed.push(input);
  }

  async markFailed(input: IdempotencyAttemptInput): Promise<void> {
    this.pending.delete(input.idempotencyKey);
  }

  async delete(input: IdempotencyAttemptInput): Promise<void> {
    this.pending.delete(input.idempotencyKey);
  }

  async cleanupExpired(): Promise<number> {
    return 0;
  }
}

class ShortDeadlineIdempotencyService implements IdempotencyServicePort {
  constructor(private readonly service: IdempotencyService) {}

  execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>> {
    return this.service.execute(
      {
        ...input,
        timeoutMs: 1_000,
        deadlineAt: new Date(Date.now() + 250),
      },
      work,
      decodeReplay,
    );
  }
}

class StubDownstream {
  readonly started: Promise<void>;
  private announceStarted: () => void = () => undefined;
  private resolvePending: () => void = () => undefined;
  private readonly pending: Promise<void>;
  readonly release = (): void => this.resolvePending();
  readonly port: OperationDispatcherPort;

  constructor() {
    this.started = new Promise<void>((resolvePromise) => {
      this.announceStarted = resolvePromise;
    });
    this.pending = new Promise<void>((resolvePromise) => {
      this.resolvePending = resolvePromise;
    });
    this.port = {
      dispatch: async () => {
        this.announceStarted();
        await this.pending;
        const response = JSON.parse(
          readFileSync(
            resolve(
              process.cwd(),
              'test/fixtures/ai-writing/grade-task1.response.json',
            ),
            'utf8',
          ),
        ) as unknown;
        return {
          operation: 'writing.task1.grade',
          data: response,
          downstreamMs: 20,
        } as DispatchResult<unknown>;
      },
    } as unknown as OperationDispatcherPort;
  }
}

class InMemoryUsageRepository implements UsageRepositoryPort {
  readonly records: UsageRecord[] = [];

  async insert(record: UsageRecord): Promise<void> {
    this.records.push(record);
  }

  async aggregate(_query: UsageAggregateQuery): Promise<UsageAggregate> {
    return {
      billableRequestCount: 0,
      billableTokenCount: 0,
      missingUsageCount: 0,
    };
  }
}

function refuseNewConnection(port: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
      (response) => {
        response.resume();
        resolvePromise(response.statusCode);
      },
    );
    request.once('error', reject);
    request.end();
  });
}

class CapturingSpanExporter extends InMemorySpanExporter {
  readonly exported: ReadableSpan[] = [];

  override export(
    spans: ReadableSpan[],
    callback: Parameters<InMemorySpanExporter['export']>[1],
  ): void {
    this.exported.push(...spans);
    super.export(spans, callback);
  }
}

describe('application shutdown drain', () => {
  it('drains a graded request, persists its result and usage, refuses new connections, and flushes its span', async () => {
    const exporter = new CapturingSpanExporter();
    const sdk = new NodeSDK({
      spanProcessors: [
        new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 }),
      ],
      instrumentations: [],
    });
    sdk.start();

    const idempotencyRepository = new InMemoryIdempotencyRepository();
    const idempotency = new ShortDeadlineIdempotencyService(
      new IdempotencyService(idempotencyRepository),
    );
    const usageRepository = new InMemoryUsageRepository();
    const downstream = new StubDownstream();
    const concurrency: ConcurrencyLimiterPort = {
      acquire: async () => ({
        allowed: true,
        lease: { release: async () => undefined },
      }),
    };
    const quota: QuotaCounterPort = {
      read: async () => 0,
      increment: async () => undefined,
    };
    const runtimeConfiguration = {
      ...appConfig(),
      NODE_ENV: 'test' as const,
      AIHUB_ALLOW_UNAUTHENTICATED_DEV: true,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(appConfig.KEY)
      .useValue(runtimeConfiguration)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotency)
      .overrideProvider(OPERATION_DISPATCHER)
      .useValue(downstream.port)
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue(concurrency)
      .overrideProvider(QUOTA_COUNTER)
      .useValue(quota)
      .overrideProvider(USAGE_REPOSITORY)
      .useValue(usageRepository)
      .compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new GracefulFastifyAdapter({ genReqId: () => generateRequestId() }, () =>
        sdk.shutdown(),
      ),
    );
    const fastify = app.getHttpAdapter().getInstance();
    registerRequestHooks(fastify, trace.getTracer('aihub.request.shutdown'));
    registerMetricsRoute(fastify);
    await app.init();
    await fastify.ready();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP listener');
    }
    const url = `http://127.0.0.1:${address.port}${GRADE_PATH}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
          'idempotency-key': 'shutdown-drain',
        },
        body: JSON.stringify(GRADE_BODY),
      });
      await downstream.started;
      expect(response.status).toBe(504);
      await response.arrayBuffer();

      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
        return undefined;
      });
      for (
        let attempt = 0;
        attempt < 20 && app.getHttpServer().listening;
        attempt += 1
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(app.getHttpServer().listening).toBe(false);
      expect(closed).toBe(false);
      await expect(refuseNewConnection(address.port)).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });

      downstream.release();
      await closing;

      expect(idempotencyRepository.completed).toHaveLength(1);
      expect(usageRepository.records).toHaveLength(1);
      expect(usageRepository.records[0]?.httpStatus).toBe(504);
      expect(
        exporter.exported.some((span) => span.name === `POST ${GRADE_PATH}`),
      ).toBe(true);
    } finally {
      downstream.release();
      if (app.getHttpServer().listening) {
        await app.close();
      }
      await sdk.shutdown();
    }
  }, 15_000);
});
