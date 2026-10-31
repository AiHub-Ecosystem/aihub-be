import Fastify from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import {
  getRequestLifecycle,
  registerRequestLifecycle,
} from '@/common/http/request-lifecycle.hook';
import {
  registerRequestTiming,
  requestAdmissionMs,
} from '@/common/http/request-timing.hook';
import type {
  BaseGradingCommand,
  GradingOrchestratorPort,
} from '@/modules/gateway/application/grading-orchestrator.port';
import type { RequestFor } from '@/modules/gateway/application/operation-dispatcher.port';
import {
  type GradedRequestExecutorPort,
  type PreparedGradedInput,
} from '@/modules/gateway/public/graded-request-executor';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import type { MeteringFinalizeInput } from '@/modules/metering/application/metering-finalizer.port';
import type { MeteringFinalizerPort } from '@/modules/metering/application/metering-finalizer.port';
import {
  requestGradedCompletionMs,
  setGradedRequestDimensions,
} from '@/modules/metering/public/graded-request-timing';
import {
  getMeteringEvidence,
  openMeteringEvidence,
} from '@/modules/metering/public/metering-evidence';
import { GradedRequestExecutor } from './graded-request-executor';

function executorHarness() {
  let command: BaseGradingCommand | undefined;
  const dispatchFailure = new Error('stub orchestrator invoked');
  const orchestrator: GradingOrchestratorPort = {
    async execute<C extends BaseGradingCommand>(received: C): Promise<never> {
      command = received;
      received.onDispatchStart?.();
      received.onAiServiceResultAvailable?.();
      received.backgroundLifecycle?.started();
      await received.backgroundLifecycle?.settled();
      await received.backgroundLifecycle?.completed?.();
      throw dispatchFailure;
    },
  };
  const finalized: MeteringFinalizeInput[] = [];
  const finalizer: MeteringFinalizerPort = {
    async finalize(input) {
      finalized.push(input);
    },
  };
  const executor: GradedRequestExecutorPort = new GradedRequestExecutor(
    orchestrator,
    finalizer,
  );
  return { executor, getCommand: () => command, dispatchFailure, finalized };
}

async function executeRoute<K extends OperationId>(
  operation: K,
  executor: GradedRequestExecutorPort,
  dispatchFailure: Error,
  prepareInput: (
    signal: AbortSignal,
  ) =>
    | PreparedGradedInput<RequestFor<K>>
    | Promise<PreparedGradedInput<RequestFor<K>>>,
  configureRequest: (request: AuthenticatedRequest) => void = () => undefined,
  inboundHeaders: Record<string, string> = {},
): Promise<{
  request: AuthenticatedRequest;
  statusCode: number;
  lifecycleAfterExecute: ReturnType<typeof getRequestLifecycle>;
  thrownError: unknown;
}> {
  const app = Fastify();
  registerRequestLifecycle(app);
  registerRequestTiming(app);
  let request: AuthenticatedRequest | undefined;
  let lifecycleAfterExecute: ReturnType<typeof getRequestLifecycle>;
  let thrownError: unknown;

  app.post(OPERATION_CATALOG[operation].path, async (receivedRequest) => {
    request = receivedRequest;
    receivedRequest.aihubAuth = {
      organizationId: 'org_test',
      apiKeyId: 'key_test',
      environment: 'test',
      scopes: ['writing.grade', 'speaking.grade'],
      rateLimitRpm: 10,
      maxConcurrent: 1,
      monthlyRequestQuota: null,
      hardStopOnQuota: true,
      allowedEnvironments: ['test'],
    };
    receivedRequest.aihubIdentity = {
      userId: 'user_test',
      organizationId: 'org_test',
      scopes: [],
      mode: 'declared_id',
    };
    openMeteringEvidence(receivedRequest, {
      operation,
      organizationId: 'org_test',
      apiKeyId: 'key_test',
      environment: 'test',
    });
    setGradedRequestDimensions(receivedRequest, {
      operation,
      identityMode: 'declared_id',
      retryBudget: 'none',
    });
    configureRequest(receivedRequest);

    try {
      await executor.execute(receivedRequest, operation, prepareInput);
    } catch (error) {
      thrownError = error;
      lifecycleAfterExecute = getRequestLifecycle(receivedRequest.raw);
      if (error !== dispatchFailure) {
        throw error;
      }
    }

    lifecycleAfterExecute = getRequestLifecycle(receivedRequest.raw);
    return { ok: true };
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: OPERATION_CATALOG[operation].path,
      headers: inboundHeaders,
    });
    if (request === undefined) {
      throw new Error('graded route did not receive a request');
    }
    return {
      request,
      statusCode: response.statusCode,
      lifecycleAfterExecute,
      thrownError,
    };
  } finally {
    await app.close();
  }
}

describe('GradedRequestExecutorPort', () => {
  it('builds request metadata and skips idempotency and background billing for none', async () => {
    const { executor, getCommand, dispatchFailure, finalized } =
      executorHarness();
    let headerReads = 0;
    let replayReads = 0;
    let preparedSignal: AbortSignal | undefined;
    const { request, statusCode, lifecycleAfterExecute } = await executeRoute(
      'speaking.grading-json',
      executor,
      dispatchFailure,
      (signal) => {
        preparedSignal = signal;
        return {
          input: {
            audioUrl: 'https://s3.wispace.app/audio/sample.mp3',
            part: 1,
            questionId: 'p1_hometown',
            testType: 'Practice',
          },
        };
      },
      (testRequest) => {
        Object.defineProperty(testRequest.headers, 'idempotency-key', {
          configurable: true,
          get: () => {
            headerReads += 1;
            return 'must-not-be-read';
          },
        });
        Object.defineProperty(testRequest, 'aihubCompletedReplay', {
          configurable: true,
          get: () => {
            replayReads += 1;
            return undefined;
          },
        });
      },
      {
        'x-aihub-organization-id': 'org_spoofed',
        'x-aihub-user-id': 'spoofed-user',
        'x-aihub-user-identity-mode': 'signed_assertion',
      },
    );

    const command = getCommand();
    expect(statusCode).toBe(200);
    expect(command?.requestId).toBe(request.id);
    expect(command?.receivedAt).toBeInstanceOf(Date);
    expect(command?.signal).toBe(preparedSignal);
    expect(command).toMatchObject({
      organizationId: 'org_test',
      apiKeyId: 'key_test',
      environment: 'test',
      userId: 'user_test',
      identityMode: 'declared_id',
      scopes: ['writing.grade', 'speaking.grade'],
    });
    expect(typeof command?.onDispatchStart).toBe('function');
    expect(typeof command?.onAiServiceResultAvailable).toBe('function');
    expect(headerReads).toBe(0);
    expect(replayReads).toBe(0);
    expect(command).not.toHaveProperty('idempotencyKey');
    expect(command).not.toHaveProperty('completedReplay');
    expect(command).not.toHaveProperty('backgroundLifecycle');
    expect(finalized).toHaveLength(0);
    expect(requestAdmissionMs(request.raw)).toBeDefined();
    expect(
      getMeteringEvidence(request)?.gradedRequestTiming?.completionStartedAt,
    ).toBeDefined();
    expect(requestGradedCompletionMs(request)).toBeUndefined();
    expect(lifecycleAfterExecute).toBeUndefined();
  });

  it('resolves the key, checks replay, and bills background completion when required', async () => {
    const { executor, getCommand, dispatchFailure, finalized } =
      executorHarness();
    let headerReads = 0;
    let replayReads = 0;
    const { request, statusCode, lifecycleAfterExecute } = await executeRoute(
      'writing.task1.grade',
      executor,
      dispatchFailure,
      () => ({
        input: {
          question: 'Describe the chart.',
          chart_type: 'Bar Chart',
          essay: 'The chart shows a steady increase.',
          image_url: 'https://example.com/chart.png',
        },
      }),
      (testRequest) => {
        Object.defineProperty(testRequest.headers, 'idempotency-key', {
          configurable: true,
          get: () => {
            headerReads += 1;
            return 'graded-request-key';
          },
        });
        Object.defineProperty(testRequest, 'aihubCompletedReplay', {
          configurable: true,
          get: () => {
            replayReads += 1;
            return undefined;
          },
        });
      },
    );

    expect(statusCode).toBe(200);
    expect(headerReads).toBe(1);
    expect(replayReads).toBe(1);
    expect(getCommand()).toMatchObject({
      operation: 'writing.task1.grade',
      idempotencyKey: 'graded-request-key',
    });
    expect(getCommand()?.backgroundLifecycle).toBeDefined();
    expect(getCommand()?.completedReplay).toBeUndefined();
    expect(requestGradedCompletionMs(request)).toBeDefined();
    expect(finalized).toMatchObject([
      { billingBasis: 'background_completion', httpStatus: 200 },
    ]);
    expect(lifecycleAfterExecute).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['whitespace', '   '],
  ] as const)(
    'rejects a %s End-User ID before orchestration and disposes resources',
    async (_name, userId) => {
      const { executor, dispatchFailure, getCommand, finalized } =
        executorHarness();
      let released = 0;
      const { request, statusCode, lifecycleAfterExecute, thrownError } =
        await executeRoute(
          'speaking.grading-json',
          executor,
          dispatchFailure,
          () => ({
            input: {
              audioUrl: 'https://s3.wispace.app/audio/sample.mp3',
              part: 1,
              questionId: 'p1_hometown',
              testType: 'Practice',
            },
            release: () => {
              released += 1;
            },
          }),
          (testRequest) => {
            if (userId === undefined) {
              delete testRequest.aihubIdentity;
            } else {
              testRequest.aihubIdentity = {
                userId,
                organizationId: 'org_test',
                scopes: [],
                mode: 'declared_id',
              };
            }
          },
        );

      expect(statusCode).toBe(500);
      expect(thrownError).toMatchObject({ code: 'USER_IDENTITY_REQUIRED' });
      expect(getCommand()).toBeUndefined();
      expect(finalized).toEqual([]);
      expect(released).toBe(1);
      expect(lifecycleAfterExecute).toBeUndefined();
      expect(request.aihubIdentity?.userId).toBe(userId);
    },
  );

  it('disposes the request lifecycle when input preparation fails', async () => {
    const { executor, dispatchFailure } = executorHarness();
    const { statusCode, lifecycleAfterExecute } = await executeRoute(
      'speaking.grading',
      executor,
      dispatchFailure,
      () => {
        throw new Error('invalid multipart input');
      },
    );

    expect(statusCode).toBe(500);
    expect(lifecycleAfterExecute).toBeUndefined();
  });
});
