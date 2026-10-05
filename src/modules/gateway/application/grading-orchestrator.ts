import { Value } from '@sinclair/typebox/value';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  type GradeResponse,
  decodeGradeResponse,
} from '@/contracts/writing/grading';
import type {
  IdempotencyBackgroundLifecycle,
  IdempotencyServicePort,
  IdempotencyWorkContext,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  readDispatchTelemetry,
  withDispatchTelemetry,
} from './dispatch-telemetry';
import type {
  BaseGradingCommand,
  GradeTask1Command,
  GradeTask2Command,
  GradingOrchestratorPort,
  ResponseForCommand,
} from './grading-orchestrator.port';
import {
  type DispatchResult,
  type OperationDispatcherPort,
  type RequestFor,
  type ResponseFor,
} from './operation-dispatcher.port';

type WritingCommand = GradeTask1Command | GradeTask2Command;

export type CatalogLookup = Readonly<
  Record<
    string,
    Pick<OperationDef, 'timeoutMs' | 'idempotency' | 'responseContract'>
  >
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idempotencyKeyOf(command: BaseGradingCommand): string | undefined {
  if (
    'idempotencyKey' in command &&
    typeof command.idempotencyKey === 'string'
  ) {
    return command.idempotencyKey;
  }
  return undefined;
}

function backgroundLifecycleOf(
  command: BaseGradingCommand,
): IdempotencyBackgroundLifecycle | undefined {
  if (
    'backgroundLifecycle' in command &&
    typeof command.backgroundLifecycle === 'object' &&
    command.backgroundLifecycle !== null
  ) {
    return command.backgroundLifecycle as IdempotencyBackgroundLifecycle;
  }
  return undefined;
}

function malformedShape(
  value: Record<string, unknown>,
  operation: OperationId,
): boolean {
  return (
    value.operation !== operation ||
    typeof value.downstreamMs !== 'number' ||
    !Number.isFinite(value.downstreamMs) ||
    value.downstreamMs < 0 ||
    !('data' in value)
  );
}

function decodeWritingReplay(
  value: unknown,
  operation: WritingCommand['operation'],
): DispatchResult<GradeResponse> {
  if (!isRecord(value) || malformedShape(value, operation)) {
    throw new Error(`stored ${operation} grading response is malformed`);
  }

  return withDispatchTelemetry(
    {
      operation,
      data: decodeGradeResponse(value.data),
      downstreamMs: value.downstreamMs as number,
    },
    readDispatchTelemetry(value),
  );
}

function decodeStoredResult<K extends OperationId>(
  value: unknown,
  operation: K,
  responseContract: OperationDef['responseContract'],
): DispatchResult<ResponseFor<K>> {
  if (operation.startsWith('writing.')) {
    return decodeWritingReplay(
      value,
      operation as WritingCommand['operation'],
    ) as DispatchResult<ResponseFor<K>>;
  }

  if (
    !isRecord(value) ||
    malformedShape(value, operation) ||
    responseContract === 'unresolved' ||
    !Value.Check(responseContract, value.data)
  ) {
    throw new Error(`stored ${operation} grading response is malformed`);
  }

  // `value.data` just passed `Value.Check` against the operation's own
  // response contract, so the parse cannot produce a shape outside it.
  return withDispatchTelemetry(
    {
      operation,
      data: Value.Parse(responseContract, value.data),
      downstreamMs: value.downstreamMs as number,
    },
    readDispatchTelemetry(value),
  ) as DispatchResult<ResponseFor<K>>;
}

export class GradingOrchestrator implements GradingOrchestratorPort {
  constructor(
    private readonly dispatcher: OperationDispatcherPort,
    private readonly idempotency: IdempotencyServicePort,
    private readonly catalog: CatalogLookup = OPERATION_CATALOG,
  ) {}

  async execute<C extends BaseGradingCommand>(
    command: C,
  ): Promise<DispatchResult<ResponseForCommand<C>>> {
    const def = this.catalog[command.operation];
    if (def === undefined) {
      throw new Error(`Unknown operation: ${command.operation}`);
    }
    const context = createRequestContext({
      requestId: command.requestId,
      receivedAt: command.receivedAt,
      deadlineMs: def.timeoutMs,
      organizationId: command.organizationId,
      apiKeyId: command.apiKeyId,
      environment: command.environment,
      ...(command.sandboxOrganizationDispatchLimit === undefined
        ? {}
        : {
            sandboxOrganizationDispatchLimit:
              command.sandboxOrganizationDispatchLimit,
          }),
      userId: command.userId,
      scopes: command.scopes,
      signal: command.signal,
    });

    const dispatch = (
      work?: IdempotencyWorkContext,
    ): Promise<DispatchResult<ResponseForCommand<C>>> =>
      this.dispatcher.dispatch(
        command.operation,
        // TS cannot correlate a generic command's `operation` with its own
        // `input`; the constraint on `BaseGradingCommand` already ties them,
        // so this narrows the union one generic command carries.
        command.input as RequestFor<C['operation']>,
        work === undefined
          ? context
          : { ...context, signal: work.signal, deadlineAt: work.deadlineAt },
      ) as Promise<DispatchResult<ResponseForCommand<C>>>;

    if (def.idempotency !== 'required') {
      return dispatch();
    }

    const idempotencyKey = idempotencyKeyOf(command);
    const backgroundLifecycle = backgroundLifecycleOf(command);
    const execution = await this.idempotency.execute(
      {
        organizationId: command.organizationId,
        operation: command.operation,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        actorId: command.userId,
        requestBody: command.input,
        requestId: command.requestId,
        timeoutMs: def.timeoutMs,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
      },
      dispatch,
      (value) =>
        decodeStoredResult(
          value,
          command.operation,
          def.responseContract,
        ) as DispatchResult<ResponseForCommand<C>>,
    );

    return execution.replay
      ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
      : execution.result;
  }
}
