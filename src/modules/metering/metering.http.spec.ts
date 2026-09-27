import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../app.module';
import { registerRequestLifecycle } from '../../common/http/request-lifecycle.hook';
import { generateRequestId } from '../../common/request-context/request-id';
import { METERING_FINALIZER } from '../../common/request-metering/metering-finalizer.port';
import type { MeteringFinalizeInput } from '../../common/request-metering/metering-finalizer.port';
import { OPERATION_DISPATCHER } from '../gateway/application/operation-dispatcher.port';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '../idempotency/application/idempotency-service.port';
import { IDEMPOTENCY_SERVICE } from '../idempotency/application/idempotency-service.port';

class FakeFinalizer {
  readonly inputs: MeteringFinalizeInput[] = [];

  finalize(input: MeteringFinalizeInput): Promise<void> {
    this.inputs.push(input);
    return Promise.resolve();
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

describe('authenticated metering HTTP boundary', () => {
  let app: NestFastifyApplication;
  let finalizer: FakeFinalizer;
  const originalAllowBypass = process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = 'true';
    finalizer = new FakeFinalizer();

    const dispatcher = {
      dispatch: async () => ({
        operation: 'writing.task1.grade' as const,
        data: { accepted: true },
        downstreamMs: 7,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(METERING_FINALIZER)
      .useValue(finalizer)
      .overrideProvider(OPERATION_DISPATCHER)
      .useValue(dispatcher)
      .overrideProvider(IDEMPOTENCY_SERVICE)
      .useValue(idempotency)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    registerRequestLifecycle(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    process.env.AIHUB_ALLOW_UNAUTHENTICATED_DEV = originalAllowBypass;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('writes exactly one billable record before a successful response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'metering-success' },
      payload: {
        question: 'Describe the chart.',
        chart_type: 'Bar Chart',
        essay: 'A clear essay.',
        image_url: 'https://example.com/chart.png',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(finalizer.inputs).toHaveLength(1);
    expect(finalizer.inputs[0]).toEqual(
      expect.objectContaining({
        operation: 'writing.task1.grade',
        outcome: 'success',
      }),
    );
  });

  it('writes one non-billable row for an authenticated validation failure', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ielts/writing/task1/grade',
      headers: { 'idempotency-key': 'metering-invalid' },
      payload: { question: 'missing the required grading fields' },
    });

    expect(response.statusCode).toBe(400);
    expect(finalizer.inputs).toHaveLength(2);
    expect(finalizer.inputs[1]).toEqual(
      expect.objectContaining({
        operation: 'writing.task1.grade',
        outcome: 'client_error',
        httpStatus: 400,
      }),
    );
  });
});
