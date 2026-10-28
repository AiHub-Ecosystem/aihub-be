import { isRecord } from '@/common/is-record';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  IdempotencyServicePort,
  IdempotencyWorkContext,
} from '@/modules/idempotency/application/idempotency-service.port';
import {
  readDispatchTelemetry,
  withDispatchTelemetry,
} from './dispatch-telemetry';
import type {
  BaseGradingCommand,
  GradingOrchestratorPort,
  ResponseForCommand,
} from './grading-orchestrator.port';
import {
  type DispatchResult,
  type OperationDispatcherPort,
  type RequestFor,
  type ResponseFor,
} from './operation-dispatcher.port';

export type CatalogLookup = Readonly<
  Record<
    string,
    Pick<OperationDef, 'timeoutMs' | 'idempotency' | 'responseContract'>
  >
>;

function isMalformed(
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

function decodeStoredResult<K extends OperationId>(
  value: unknown,
  operation: K,
  def: Pick<OperationDef, 'responseContract'>,
): DispatchResult<ResponseFor<K>> {
  const data =
    isRecord(value) &&
    !isMalformed(value, operation) &&
    def.responseContract !== 'unresolved'
      ? parseStoredData(def.responseContract, value.data)
      : undefined;
  if (!isRecord(value) || data === undefined) {
    const operationGroup = operation.split('.')[0] ?? 'graded';
    const label = `${operationGroup[0]?.toUpperCase()}${operationGroup.slice(1)}`;
    throw new Error(`stored ${label} grading response is malformed`);
  }

  return withDispatchTelemetry(
    {
      operation,
      data,
      downstreamMs: value.downstreamMs as number,
    },
    readDispatchTelemetry(value),
  ) as DispatchResult<ResponseFor<K>>;
}

/**
 * A stored body may have been written by a newer release that added members
 * (#754), so unknown members are cleaned away rather than refused. `Convert`
 * stays out: a known member of the wrong type is still a malformed body.
 */
function parseStoredData(contract: TSchema, data: unknown): unknown {
  try {
    return Value.Parse(
      ['Clone', 'Clean', 'Default', 'Assert', 'Decode'],
      contract,
      data,
    );
  } catch {
    return undefined;
  }
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
      userId: command.userId,
      scopes: command.scopes,
      signal: command.signal,
    });

    const dispatch = (
      work?: IdempotencyWorkContext,
    ): Promise<DispatchResult<ResponseForCommand<C>>> => {
      command.onDispatchStart?.();
      return (async () => {
        const result = (await this.dispatcher.dispatch(
          command.operation,
          // TS cannot correlate a generic command's `operation` with its own
          // `input`; the constraint on `BaseGradingCommand` already ties them,
          // so this narrows the union one generic command carries.
          command.input as RequestFor<C['operation']>,
          work === undefined
            ? context
            : { ...context, signal: work.signal, deadlineAt: work.deadlineAt },
        )) as DispatchResult<ResponseForCommand<C>>;
        command.onAiServiceResultAvailable?.();
        return result;
      })();
    };

    if (def.idempotency === 'none') {
      return dispatch();
    }

    const preloadedReplay = command.completedReplay;
    if (preloadedReplay !== undefined) {
      if (
        preloadedReplay.responseStatus < 200 ||
        preloadedReplay.responseStatus >= 300
      ) {
        throw new Error('stored idempotency response status is not successful');
      }
      return {
        ...decodeStoredResult(
          preloadedReplay.responseBody,
          command.operation,
          def,
        ),
        downstreamMs: 0,
        idempotentReplay: true,
      } as DispatchResult<ResponseForCommand<C>>;
    }

    const execution = await this.idempotency.execute(
      {
        organizationId: command.organizationId,
        operation: command.operation,
        ...(command.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: command.idempotencyKey }),
        actorId: command.userId,
        requestBody: command.input,
        requestId: command.requestId,
        timeoutMs: def.timeoutMs,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        ...(command.backgroundLifecycle === undefined
          ? {}
          : { backgroundLifecycle: command.backgroundLifecycle }),
      },
      dispatch,
      (value) =>
        decodeStoredResult(value, command.operation, def) as DispatchResult<
          ResponseForCommand<C>
        >,
    );

    return execution.replay
      ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
      : execution.result;
  }
}
