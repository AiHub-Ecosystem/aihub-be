import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { RequestContext } from '@/common/request-context/request-context';
import type { SpeakingGradeResponse } from '@/contracts/speaking/grading';
import type { GradeResponse } from '@/contracts/writing/grading';
import type {
  IdempotencyExecution,
  IdempotencyExecutionInput,
  IdempotencyReplayDecoder,
  IdempotencyServicePort,
  IdempotencyWork,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  type CatalogLookup,
  GradingOrchestrator,
} from './grading-orchestrator';
import type { GradingRequestMetadata } from './grading-orchestrator.port';
import type { OperationDispatcherPort } from './operation-dispatcher.port';

const writingData: GradeResponse = {
  overall_band: 7,
  language: 'vi',
  criteria: [],
  summary: '',
  suggestions: [],
  next_steps: [],
  annotations: [],
};
const speakingData = {} as SpeakingGradeResponse;
const receivedAt = new Date('2026-09-27T04:00:00.000Z');

function metadata(signal: AbortSignal): GradingRequestMetadata {
  return {
    requestId: 'req-fifth',
    receivedAt,
    signal,
    organizationId: 'org-fifth',
    apiKeyId: 'key-fifth',
    environment: 'production',
    userId: 'user-fifth',
    scopes: ['writing.grade', 'speaking.grade'],
  };
}

function fixture(catalog: CatalogLookup) {
  const calls: Array<{
    operation: OperationId;
    input: unknown;
    context: RequestContext;
  }> = [];
  const executions: IdempotencyExecutionInput[] = [];
  const workSignal = new AbortController().signal;
  const workDeadline = new Date('2026-09-27T04:02:00.000Z');
  const dispatcher = {
    dispatch: async <O extends OperationId>(
      operation: O,
      input: unknown,
      context: RequestContext,
    ) => {
      calls.push({ operation, input, context });
      return {
        operation,
        data: operation.startsWith('writing.') ? writingData : speakingData,
        downstreamMs: 23,
      };
    },
  } as OperationDispatcherPort;
  const idempotency: IdempotencyServicePort = {
    async execute<T>(
      input: IdempotencyExecutionInput,
      work: IdempotencyWork<T>,
      _decodeReplay: IdempotencyReplayDecoder<T>,
    ): Promise<IdempotencyExecution<T>> {
      executions.push(input);
      const result = await work({
        signal: workSignal,
        deadlineAt: workDeadline,
      });
      return { result, replay: false };
    },
  };
  const orchestrator = new GradingOrchestrator(
    dispatcher,
    idempotency,
    catalog,
  );
  return { orchestrator, calls, executions, workSignal, workDeadline };
}

describe('Gateway operation extensibility', () => {
  it('dispatches a fifth Writing operation through the catalog entry and adapter alone', async () => {
    const catalog = {
      ...OPERATION_CATALOG,
      'writing.echo.grade': {
        ...OPERATION_CATALOG['writing.task1.grade'],
        timeoutMs: 5_000,
      },
    };
    const { orchestrator, calls, executions, workSignal, workDeadline } =
      fixture(catalog);
    const signal = new AbortController().signal;

    const result = await orchestrator.execute({
      ...metadata(signal),
      operation: 'writing.echo.grade' as OperationId,
      input: { essay: 'x' },
    } as Parameters<typeof orchestrator.execute>[0]);

    expect(result).toMatchObject({ operation: 'writing.echo.grade' });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      operation: 'writing.echo.grade',
      timeoutMs: 5_000,
      signal,
      deadlineAt: new Date(receivedAt.getTime() + 5_000),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toMatchObject({
      signal: workSignal,
      deadlineAt: workDeadline,
    });
  });

  it('dispatches a fifth Speaking operation without the idempotency boundary', async () => {
    const catalog = {
      ...OPERATION_CATALOG,
      'speaking.echo': {
        ...OPERATION_CATALOG['speaking.grading'],
        idempotency: 'none' as const,
        timeoutMs: 7_000,
      },
    };
    const { orchestrator, calls, executions } = fixture(catalog);
    const signal = new AbortController().signal;

    const result = await orchestrator.execute({
      ...metadata(signal),
      operation: 'speaking.echo' as OperationId,
      input: {},
    } as Parameters<typeof orchestrator.execute>[0]);

    expect(result).toMatchObject({ operation: 'speaking.echo' });
    expect(executions).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toMatchObject({
      signal,
      deadlineAt: new Date(receivedAt.getTime() + 7_000),
    });
  });
});
