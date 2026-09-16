import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';
import { generateRequestId } from '../../common/request-context/request-id';
import type { GradeResponse } from '../../contracts/writing/grading';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyDecision,
  type ConcurrencyLimiterPort,
} from '../gateway/application/concurrency-limiter.port';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../gateway/application/operation-dispatcher.port';
import {
  RATE_LIMITER,
  type RateLimiterPort,
} from '../gateway/application/rate-limiter.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '../idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '../idempotency/application/idempotency-service.port';
import {
  API_KEY_AUTHENTICATOR,
  type ApiKeyAuthenticatorPort,
  type ApiKeyCredential,
  type AuthenticatedApiKey,
} from '../identity/application/api-key-authenticator.port';

const VALID_API_KEY = `aihub_sk_${'C'.repeat(43)}`;

const authenticatedApiKey: AuthenticatedApiKey = {
  organizationId: 'local-development',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 2,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

const dispatchResult: DispatchResult<GradeResponse> = {
  operation: 'writing.task1.grade',
  data: {
    overall_band: 6,
    language: 'vi',
    criteria: [
      'task_achievement',
      'coherence_cohesion',
      'lexical_resource',
      'grammatical_range_accuracy',
    ].map((id) => ({
      id: id as GradeResponse['criteria'][number]['id'],
      name: id,
      band: 6,
      band_reason: 'clear',
      strengths: [],
      improvements: [],
    })),
    summary: 'summary',
    suggestions: [],
    next_steps: [],
    annotations: [],
  },
  downstreamMs: 1,
};

class InMemoryConcurrencyLimiter implements ConcurrencyLimiterPort {
  attempts = 0;
  active = 0;
  released = 0;

  async acquire(request: Parameters<ConcurrencyLimiterPort['acquire']>[0]) {
    this.attempts += 1;
    if (this.active >= request.maxConcurrent) {
      const denied: ConcurrencyDecision = {
        allowed: false,
        retryAfterMs: 500,
      };
      return denied;
    }

    this.active += 1;
    let released = false;
    return {
      allowed: true as const,
      lease: {
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          this.active -= 1;
          this.released += 1;
        },
      },
    };
  }
}

class PendingDispatcher {
  calls = 0;
  fail = false;
  private readonly pending: Array<
    (result: DispatchResult<GradeResponse>) => void
  > = [];

  readonly port = {
    dispatch: (): Promise<DispatchResult<GradeResponse>> => {
      this.calls += 1;
      if (this.fail) {
        return Promise.reject(new Error('downstream failed'));
      }

      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    },
  } as unknown as OperationDispatcherPort;

  resolveAll(): void {
    const pending = this.pending.splice(0);
    for (const resolve of pending) {
      resolve(dispatchResult);
    }
  }
}

let nextRequestKey = 0;

function requestOptions() {
  nextRequestKey += 1;
  return {
    method: 'POST' as const,
    url: '/v1/ielts/writing/task1/grade',
    headers: {
      host: 'api.aihub.test',
      'x-api-key': VALID_API_KEY,
      'idempotency-key': `concurrency-test-${nextRequestKey}`,
    },
    payload: {
      question: 'Describe the chart.',
      chart_type: 'Bar Chart',
      essay: 'The chart shows a clear trend.',
      image_url: 'https://example.com/chart.png',
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Writing concurrency HTTP flow', () => {
  let app: NestFastifyApplication;
  let limiter: InMemoryConcurrencyLimiter;
  let dispatcher: PendingDispatcher;
  const originalEnv = {
    allowDev: process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV,
    nodeEnv: process.env.NODE_ENV,
    productionHost: process.env.AIHUB_PRODUCTION_HOST,
  };

  const authenticator: ApiKeyAuthenticatorPort = {
    authenticate: async (_credentials: ApiKeyCredential) => authenticatedApiKey,
  };
  const rateLimiter: RateLimiterPort = {
    consume: async () => ({ allowed: true }),
  };
  const idempotencyService: IdempotencyServicePort = {
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
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    process.env.AIHUB_PRODUCTION_HOST = 'api.aihub.test';

    limiter = new InMemoryConcurrencyLimiter();
    dispatcher = new PendingDispatcher();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(API_KEY_AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(RATE_LIMITER)
      .useValue(rateLimiter)
      .overrideProvider(CONCURRENCY_LIMITER)
      .useValue(limiter)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotencyService)
      .overrideProvider(OPERATION_DISPATCHER)
      .useValue(dispatcher.port)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    dispatcher.resolveAll();
    dispatcher.fail = false;
  });

  afterAll(async () => {
    await app.close();

    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalEnv.allowDev;
    process.env.NODE_ENV = originalEnv.nodeEnv;
    if (originalEnv.productionHost === undefined) {
      Reflect.deleteProperty(process.env, 'AIHUB_PRODUCTION_HOST');
    } else {
      process.env.AIHUB_PRODUCTION_HOST = originalEnv.productionHost;
    }
  });

  it('rejects exactly one of N+1 concurrent requests and releases both successful leases', async () => {
    const first = app.inject(requestOptions());
    const second = app.inject(requestOptions());
    const third = app.inject(requestOptions());

    for (let attempt = 0; attempt < 20 && limiter.attempts < 3; attempt += 1) {
      await flush();
    }

    expect(limiter.attempts).toBe(3);
    expect(limiter.active).toBe(2);
    expect(dispatcher.calls).toBe(2);

    const rejected = await third;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({
      error: {
        code: 'CONCURRENCY_LIMIT',
        retryable: true,
        retry_after_ms: 500,
      },
    });

    dispatcher.resolveAll();
    const successful = await Promise.all([first, second]);
    expect(successful.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);

    for (let attempt = 0; attempt < 5 && limiter.active !== 0; attempt += 1) {
      await flush();
    }
    expect(limiter.active).toBe(0);
    expect(limiter.released).toBe(2);
  });

  it('releases the lease when the handler fails so the next request is not blocked', async () => {
    dispatcher.fail = true;

    const failed = await app.inject(requestOptions());
    expect(failed.statusCode).toBe(500);

    for (let attempt = 0; attempt < 5 && limiter.active !== 0; attempt += 1) {
      await flush();
    }
    expect(limiter.active).toBe(0);

    dispatcher.fail = false;
    const next = app.inject(requestOptions());
    for (let attempt = 0; attempt < 5 && dispatcher.calls < 4; attempt += 1) {
      await flush();
    }
    dispatcher.resolveAll();

    await expect(next).resolves.toMatchObject({ statusCode: 200 });
    for (let attempt = 0; attempt < 5 && limiter.active !== 0; attempt += 1) {
      await flush();
    }
    expect(limiter.active).toBe(0);
  });
});
